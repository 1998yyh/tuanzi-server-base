import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { BackgroundTask, BackgroundTaskStatus } from './background-task.entity';
import { AgentConfig } from '../entities/agent-config.entity';
import { Conversation } from '../entities/conversation.entity';
import { Message, MessageRole } from '../entities/message.entity';
import { AgentExecutorService } from '../agent-executor.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { ConversationExecutionLock } from '../utils/conversation-execution-lock';

/** 单轮最多处理的任务数（串行，防止一轮拖垮 cron） */
const BATCH_SIZE = 5;
/** 单个后台任务的总时限（子代理级任务，比工具的 30s 宽松得多） */
const TASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 后台任务：Agent 通过 run_background_task 工具把耗时工作丢到后台异步执行，
 * 完成后结果以普通 assistant 消息写回来源会话（前端头部 pill 轮询本表）。
 *
 * - 工具只 INSERT 一行 pending 并立即返回（30s 工具超时因此不适用）
 * - 每 10s 轮询 pending 任务，原子认领后串行执行
 * - 执行走 ConversationExecutionLock：与用户流式请求排队而非并发，
 *   保证 LangGraph checkpoint 的串行不变式（见 ConversationsService 类注释）
 * 单实例假设：多实例部署需加 leader 锁（与 GenerationPollerService 一致）。
 */
@Injectable()
export class BackgroundTasksService implements OnModuleInit {
  private readonly logger = new Logger(BackgroundTasksService.name);
  private polling = false;

  constructor(
    @InjectRepository(BackgroundTask)
    private readonly taskRepo: Repository<BackgroundTask>,
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly agentExecutor: AgentExecutorService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly executionLock: ConversationExecutionLock,
  ) {}

  /** 注册 Agent 作用域工具（func 闭包捕获 agentConfigId；会话 id 从 invoke config 读） */
  onModuleInit() {
    this.toolRegistry.registerAgentScopedTool(
      'run_background_task',
      (agentConfigId) =>
        new DynamicStructuredTool({
          name: 'run_background_task',
          description:
            '把耗时任务丢到后台异步执行，立即返回任务 ID。适合预计耗时较长、用户不需要' +
            '立刻看到结果的工作（如批量整理、定时调研）。任务完成后结果会作为新消息' +
            '写回当前会话。任务描述必须完整自包含——后台执行时没有当前对话上下文可用。',
          schema: z.object({
            task: z.string().describe('交给后台执行的完整、自包含的任务描述'),
          }),
          func: async (args, _runManager, config) => {
            const conversationId = config?.configurable?.thread_id as string | undefined;
            if (!conversationId) {
              // 无 checkpoint 的一次性运行（Skill 子代理等）没有来源会话，无法写回
              return '后台任务只能在有会话的流式对话中发起';
            }
            return this.createTask(agentConfigId, conversationId, args.task as string);
          },
        }),
    );
  }

  /** 工具入口：INSERT pending 行立即返回（执行由 poller 接管） */
  async createTask(
    agentConfigId: string,
    conversationId: string,
    input: string,
  ): Promise<{ success: true; taskId: string }> {
    const task = await this.taskRepo.save(
      this.taskRepo.create({
        agentConfigId,
        conversationId,
        input,
        status: BackgroundTaskStatus.PENDING,
        resultMessageId: null,
        finishedAt: null,
      }),
    );
    this.logger.log(`后台任务 ${task.id} 已创建（会话 ${conversationId}）`);
    return { success: true, taskId: task.id };
  }

  /** 前端头部 pill 轮询：按会话列出任务（最新在前） */
  async listByConversation(conversationId: string): Promise<BackgroundTask[]> {
    return this.taskRepo.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async pollPendingTasks(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const tasks = await this.taskRepo.find({
        where: { status: BackgroundTaskStatus.PENDING },
        order: { createdAt: 'ASC' },
        take: BATCH_SIZE,
      });
      for (const task of tasks) {
        await this.runOne(task).catch((e) => {
          this.logger.error(`后台任务 ${task.id} 执行异常: ${e instanceof Error ? e.message : e}`);
        });
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * 执行单个任务：原子认领 → 会话锁排队 → runBatch 完整 tool loop →
   * 全部新增消息写回来源会话 → 置终态。
   */
  private async runOne(task: BackgroundTask): Promise<void> {
    // 原子认领：并发 poller（理论上单实例不会，防御重入间隙）只有一个能成功
    const claim = await this.taskRepo.update(
      { id: task.id, status: BackgroundTaskStatus.PENDING },
      { status: BackgroundTaskStatus.RUNNING },
    );
    if (!claim.affected) return;

    const release = await this.executionLock.acquire(task.conversationId);
    try {
      const agentConfig = await this.agentRepo.findOne({ where: { id: task.agentConfigId } });
      if (!agentConfig || !agentConfig.isActive) {
        throw new Error('Agent 不存在或已停用');
      }

      const newMessages = await this.agentExecutor.runBatch(agentConfig, task.input, {
        threadId: task.conversationId,
        signal: AbortSignal.timeout(TASK_TIMEOUT_MS),
      });

      let lastAssistantId: string | null = null;
      if (newMessages.length) {
        const saved = await this.messageRepo.save(
          newMessages.map((m) =>
            this.messageRepo.create({ conversationId: task.conversationId, ...m }),
          ),
        );
        lastAssistantId = saved.findLast((m) => m.role === MessageRole.ASSISTANT)?.id ?? null;
      }

      await this.taskRepo.update(task.id, {
        status: BackgroundTaskStatus.DONE,
        resultMessageId: lastAssistantId,
        finishedAt: new Date(),
      });
      // 顶会话到列表顶部（结果消息到达属于会话活动）
      await this.conversationRepo.update(task.conversationId, { updatedAt: new Date() });
      this.logger.log(`后台任务 ${task.id} 执行完成（会话 ${task.conversationId}）`);
    } catch (e) {
      await this.taskRepo.update(task.id, {
        status: BackgroundTaskStatus.FAILED,
        finishedAt: new Date(),
      });
      this.logger.warn(`后台任务 ${task.id} 失败: ${(e as Error).message}`);
    } finally {
      release();
    }
  }
}
