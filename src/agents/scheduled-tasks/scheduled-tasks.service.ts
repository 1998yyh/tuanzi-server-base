import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
// @nestjs/schedule v6 不再 re-export CronJob，需从 cron 包直接导入
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { CronExpressionParser } from 'cron-parser';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ScheduledTask } from './scheduled-task.entity';
import { AgentConfig } from '../entities/agent-config.entity';
import { Conversation, ConversationStatus } from '../entities/conversation.entity';
import { Message, MessageRole } from '../entities/message.entity';
import { AgentExecutorService } from '../agent-executor.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { DailyReportsService } from '../../daily-reports/daily-reports.service';
import { DailyReportType } from '../../daily-reports/daily-reports.entity';

/** 调度与「今天」日期统一按上海时区 */
const TZ = 'Asia/Shanghai';
/** 定时任务最小间隔（防止高频任务打爆 LLM 调用） */
const MIN_INTERVAL_MS = 60 * 60 * 1000;
/** 日报正文长度上限 64KB */
const MAX_CONTENT_LENGTH = 64 * 1024;

const REPORT_TYPE_LABEL: Record<DailyReportType, string> = {
  [DailyReportType.AI]: 'AI 日报',
  [DailyReportType.STOCK]: '股票日报',
};

/**
 * 定时任务管理：对话式创建/查询/删除 + cron 调度 + 触发执行 + 日报写入。
 *
 * - 4 个对话工具在 onModuleInit 注册到 ToolRegistryService（Agent 作用域工具）
 * - 应用重启后 onApplicationBootstrap 恢复全部活跃任务；停机期间错过的触发不补跑
 * - 触发执行复用 AgentExecutorService.runBatch，会话执行完自动归档
 */
@Injectable()
export class ScheduledTasksService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledTasksService.name);

  constructor(
    @InjectRepository(ScheduledTask)
    private readonly taskRepo: Repository<ScheduledTask>,
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly agentExecutor: AgentExecutorService,
    private readonly dailyReportsService: DailyReportsService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  /** 注册 4 个 Agent 作用域工具（func 闭包捕获 agentConfigId） */
  onModuleInit() {
    this.toolRegistry.registerAgentScopedTool(
      'create_scheduled_task',
      (agentConfigId) =>
        new DynamicStructuredTool({
          name: 'create_scheduled_task',
          description:
            '创建定时任务：按 cron 表达式周期触发本 Agent 自动执行指定工作（如每日生成日报）。同类型日报只能有一个活跃任务。',
          schema: z.object({
            cronExpression: z
              .string()
              .describe(
                'cron 表达式，如 "0 8 * * *" 表示每天早 8 点（Asia/Shanghai），间隔不得小于 1 小时',
              ),
            reportType: z.enum(['ai', 'stock']).describe('日报类型'),
            description: z.string().describe('任务描述，定时触发时会作为执行指令交给 Agent'),
          }),
          func: async (args) => this.createTask(agentConfigId, args),
        }),
    );

    this.toolRegistry.registerAgentScopedTool(
      'write_daily_report',
      () =>
        new DynamicStructuredTool({
          name: 'write_daily_report',
          description:
            '把整理好的日报内容写入数据库（Markdown 格式）。同类型同日期的内容会覆盖旧记录。',
          schema: z.object({
            type: z.enum(['ai', 'stock']).describe('日报类型'),
            title: z.string().describe('日报标题'),
            content: z.string().describe('日报正文（Markdown）'),
            date: z.string().optional().describe('日期 YYYY-MM-DD，缺省为今天'),
          }),
          func: async (args) => this.writeDailyReport(args),
        }),
    );

    this.toolRegistry.registerAgentScopedTool(
      'list_scheduled_tasks',
      (agentConfigId) =>
        new DynamicStructuredTool({
          name: 'list_scheduled_tasks',
          description: '列出本 Agent 的全部定时任务（含已停用的历史任务）。',
          schema: z.object({}),
          func: async () => this.listTasks(agentConfigId),
        }),
    );

    this.toolRegistry.registerAgentScopedTool(
      'delete_scheduled_task',
      (agentConfigId) =>
        new DynamicStructuredTool({
          name: 'delete_scheduled_task',
          description: '删除本 Agent 的指定定时任务。',
          schema: z.object({
            taskId: z.string().uuid().describe('任务 ID（从 list_scheduled_tasks 获取）'),
          }),
          func: async (args) => this.deleteTask(agentConfigId, args.taskId),
        }),
    );
  }

  /** 应用重启后恢复全部活跃任务；停机期间错过的触发不补跑（避免启动雪崩） */
  async onApplicationBootstrap() {
    const activeTasks = await this.taskRepo.find({ where: { isActive: true } });
    for (const task of activeTasks) {
      this.registerCronJob(task);
    }
    this.logger.log(`已恢复 ${activeTasks.length} 个定时任务`);
  }

  async createTask(
    agentConfigId: string,
    params: { cronExpression: string; reportType: string; description: string },
  ): Promise<{ success: true; taskId: string; nextRunAt: string }> {
    this.assertValidCron(params.cronExpression);
    const reportType = this.assertReportType(params.reportType);
    if (!params.description?.trim()) {
      throw new BadRequestException('描述不能为空');
    }
    if (params.description.length > 255) {
      throw new BadRequestException('描述最长 255 字符');
    }

    const existing = await this.taskRepo.findOne({
      where: { agentConfigId, reportType, isActive: true },
    });
    if (existing) {
      throw new ConflictException(
        `该 Agent 已有 ${REPORT_TYPE_LABEL[reportType]}定时任务，请先删除旧任务`,
      );
    }

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        agentConfigId,
        reportType,
        cronExpression: params.cronExpression,
        description: params.description.trim(),
        isActive: true,
        lastRunAt: null,
      }),
    );
    this.registerCronJob(task);

    // 用全新的解析实例计算下次执行时间（assertValidCron 内的迭代器已消费过）
    const nextRunAt = CronExpressionParser.parse(params.cronExpression, { tz: TZ })
      .next()
      .toDate()
      .toISOString();
    return { success: true, taskId: task.id, nextRunAt };
  }

  async listTasks(agentConfigId: string): Promise<{ tasks: ScheduledTask[] }> {
    const tasks = await this.taskRepo.find({
      where: { agentConfigId },
      order: { createdAt: 'DESC' },
    });
    return { tasks };
  }

  async deleteTask(agentConfigId: string, taskId: string): Promise<{ success: true }> {
    const task = await this.taskRepo.findOne({ where: { id: taskId, agentConfigId } });
    if (!task) {
      throw new BadRequestException('任务不存在或无权限删除');
    }
    if (this.schedulerRegistry.doesExist('cron', task.id)) {
      this.schedulerRegistry.deleteCronJob(task.id);
    }
    await this.taskRepo.remove(task);
    return { success: true };
  }

  /** write_daily_report 工具入口：手动校验后走 upsert（同类型同日期覆盖） */
  async writeDailyReport(params: {
    type: string;
    title: string;
    content: string;
    date?: string;
  }): Promise<{ success: true; id: string }> {
    const type = this.assertReportType(params.type);
    if (!params.title?.trim()) {
      throw new BadRequestException('标题不能为空');
    }
    if (params.title.length > 255) {
      throw new BadRequestException('标题最长 255 字符');
    }
    if (!params.content?.trim()) {
      throw new BadRequestException('内容不能为空');
    }
    if (params.content.length > MAX_CONTENT_LENGTH) {
      throw new BadRequestException('内容过长（最大 64KB）');
    }
    const date = params.date ?? this.todayInShanghai();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
      throw new BadRequestException('日期格式错误，应为 YYYY-MM-DD');
    }

    const report = await this.dailyReportsService.upsert({
      type,
      title: params.title.trim(),
      content: params.content,
      date,
    });
    return { success: true, id: report.id };
  }

  /**
   * cron 触发执行：新建会话 → 写触发消息 → runBatch 走完整 tool loop →
   * 落执行消息 → 归档会话 → 更新 lastRunAt。
   * 任何异常只记录日志（会话照常归档），不影响下次调度。
   */
  async runTask(taskId: string): Promise<void> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task || !task.isActive) return;

    const agentConfig = await this.agentRepo.findOne({ where: { id: task.agentConfigId } });
    if (!agentConfig || !agentConfig.isActive) {
      this.logger.warn(`定时任务 ${taskId} 的 Agent 不存在或已停用，跳过执行`);
      return;
    }

    const today = this.todayInShanghai();
    const conversation = await this.conversationRepo.save(
      this.conversationRepo.create({
        agentConfigId: agentConfig.id,
        title: `[Auto] ${REPORT_TYPE_LABEL[task.reportType]} ${today}`,
        status: ConversationStatus.ACTIVE,
      }),
    );

    try {
      const triggerMessage =
        `今天是 ${today}。请完成以下工作：${task.description}。` +
        `完成后务必调用 write_daily_report 工具，把结果保存为 ${task.reportType} 类型、日期为 ${today} 的日报。`;
      await this.messageRepo.save(
        this.messageRepo.create({
          conversationId: conversation.id,
          role: MessageRole.USER,
          content: triggerMessage,
        }),
      );

      const newMessages = await this.agentExecutor.runBatch(agentConfig, triggerMessage, {
        threadId: conversation.id,
      });
      if (newMessages.length) {
        await this.messageRepo.save(
          newMessages.map((m) =>
            this.messageRepo.create({ conversationId: conversation.id, ...m }),
          ),
        );
      }
      await this.taskRepo.update(taskId, { lastRunAt: new Date() });
      this.logger.log(`定时任务 ${taskId}（${REPORT_TYPE_LABEL[task.reportType]}）执行完成`);
    } catch (e) {
      this.logger.error(`定时任务 ${taskId} 执行失败: ${(e as Error).message}`);
    } finally {
      // 定时任务产生的会话自动归档，不干扰用户主动创建的会话列表
      await this.conversationRepo.update(conversation.id, {
        status: ConversationStatus.ARCHIVED,
      });
    }
  }

  /** 注册/重注册 cron job 到调度器（重复注册同名先删后加） */
  private registerCronJob(task: ScheduledTask): void {
    if (this.schedulerRegistry.doesExist('cron', task.id)) {
      this.schedulerRegistry.deleteCronJob(task.id);
    }
    const job = new CronJob(
      task.cronExpression,
      () => {
        void this.runTask(task.id);
      },
      null,
      true,
      TZ,
    );
    this.schedulerRegistry.addCronJob(task.id, job);
  }

  /** 校验 cron 表达式；间隔 < 1 小时的表达式拒绝 */
  private assertValidCron(expression: string): void {
    let cron;
    try {
      cron = CronExpressionParser.parse(expression, { tz: TZ });
    } catch {
      throw new BadRequestException('不合法的 cron 表达式');
    }
    const first = cron.next().toDate().getTime();
    const second = cron.next().toDate().getTime();
    if (second - first < MIN_INTERVAL_MS) {
      throw new BadRequestException('任务间隔不能少于 1 小时');
    }
  }

  private assertReportType(type: string): DailyReportType {
    if (type !== DailyReportType.AI && type !== DailyReportType.STOCK) {
      throw new BadRequestException('日报类型必须是 ai 或 stock');
    }
    return type;
  }

  /** Asia/Shanghai 时区的今天，格式 YYYY-MM-DD（en-CA locale 输出即该格式） */
  private todayInShanghai(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  }
}
