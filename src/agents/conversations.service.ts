import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { AgentConfig } from './entities/agent-config.entity';
import { Conversation, ConversationStatus } from './entities/conversation.entity';
import { Message, MessageRole } from './entities/message.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { AgentExecutorService } from './agent-executor.service';
import { TypeORMCheckpointer } from './checkpointers/typeorm.checkpointer';
import { ConversationExecutionLock } from './utils/conversation-execution-lock';
import { SseEvent } from './agents.types';

/** 会话标题默认取首条用户消息前 30 字 */
const TITLE_MAX_LENGTH = 30;

/**
 * 会话管理与 Agent 执行入口。
 *
 * 多用户隔离：所有操作先校验会话归属（join agentConfig 比对 userId），
 * 查不到统一抛 404，不区分「不存在」与「别人的」。
 *
 * ⚠️ 并发限制：同一 conversationId 串行执行由 ConversationExecutionLock 强制
 * （LangGraph checkpoint 读改写会造成状态覆盖）。锁包住 streamMessages 全程，
 * 后台任务（BackgroundTasksService）写回同一会话时同样走锁排队。
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly agentExecutor: AgentExecutorService,
    private readonly checkpointer: TypeORMCheckpointer,
    private readonly executionLock: ConversationExecutionLock,
  ) {}

  async createConversation(
    userId: string,
    agentId: string,
    dto: CreateConversationDto,
  ): Promise<Conversation> {
    const agent = await this.agentRepo.findOne({
      where: { id: agentId, userId },
    });
    if (!agent) {
      throw new NotFoundException(`Agent #${agentId} 不存在`);
    }
    if (!agent.isActive) {
      throw new GoneException('该 Agent 已停用');
    }
    return this.conversationRepo.save(
      this.conversationRepo.create({
        agentConfigId: agentId,
        title: dto.title ?? null,
      }),
    );
  }

  async listConversations(userId: string, agentId: string, query: QueryConversationsDto) {
    const agent = await this.agentRepo.findOne({
      where: { id: agentId, userId },
    });
    if (!agent) {
      throw new NotFoundException(`Agent #${agentId} 不存在`);
    }
    const { page = 1, limit = 20 } = query;
    // 显式排除归档会话：定时任务等自动产生的会话（status=archived）不混入用户列表
    const [items, total] = await this.conversationRepo.findAndCount({
      where: { agentConfigId: agentId, status: Not(ConversationStatus.ARCHIVED) },
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 同步聊天：持久化用户消息 → 执行 LangGraph → 持久化 agent 消息。
   *
   * ⚠️ 已知不对称：同步路径执行失败时，已落库的 user 消息与 checkpoint 会残留
   * （与 SSE 路径的「失败零残留」语义不同）。前端只走 SSE 路径，暂不处理。
   */
  async sendMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<{ userMessage: Message; agentMessages: Message[] }> {
    const conversation = await this.loadOwnedConversation(userId, conversationId);
    const userMsg = await this.persistUserMessage(conversation, content);

    const newMsgs = await this.agentExecutor.run(conversation.agentConfig, conversationId, content);

    const agentMessages = await this.messageRepo.save(
      newMsgs.map((m) => this.messageRepo.create({ conversationId, ...m })),
    );

    return { userMessage: userMsg, agentMessages };
  }

  /**
   * 流式聊天第一步（同步校验）：只校验归属与 Agent 状态，**不落库**。
   * 必须在 SSE 响应头发送前完成——这里抛错走正常 JSON 错误响应。
   * user 消息延迟到流正常结束后与本轮 assistant/tool 消息一起持久化
   * （streamMessages），保证流中途异常时数据库零残留，前端可原样重发。
   */
  async prepareStream(userId: string, conversationId: string): Promise<Conversation> {
    return this.loadOwnedConversation(userId, conversationId);
  }

  /**
   * 流式聊天第二步：透传 SSE 事件，同时收集 agent 消息，
   * 流结束后统一持久化（user 消息 + 本轮 assistant/tool 消息），
   * 保证消息历史完整且流中途异常时数据库零残留（前端可原样重发）。
   *
   * 持久化策略：assistant 消息以 message_end 事件的最终内容为准
   * （真实事件序中 tool_use 发生在 message_end 之后，逐事件拼接不可靠）；
   * text_delta / tool_use 仅用于前端实时展示。
   * token 消耗取最后一个 message_end 的跨轮累计值，
   * 只写在本轮最后一条 assistant 消息上（见 Message.totalTokens 注释）。
   */
  async *streamMessages(
    conversation: Conversation,
    content: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<SseEvent> {
    // 执行锁包住全程（含 baseline 捕获与失败回滚）：与后台任务/并发请求排队，
    // 保证 checkpoint 的串行读改写不变式（见类注释）
    const release = await this.executionLock.acquire(conversation.id);
    try {
      yield* this.streamMessagesLocked(conversation, content, options);
    } finally {
      release();
    }
  }

  /** streamMessages 的实际实现（调用方必须已持有会话执行锁） */
  private async *streamMessagesLocked(
    conversation: Conversation,
    content: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<SseEvent> {
    const conversationId = conversation.id;

    const pendingMessages: Partial<Message>[] = [];
    let totalTokens = 0;

    // 失败零残留：记录流开始前的 checkpoint 水位，异常时回滚本轮写入。
    // ⚠️ 前提：同一 conversationId 串行执行（见类注释的并发限制）——若并发请求
    // 同时写同一 thread，回滚可能删掉对方本轮写入的 checkpoint 行。
    const baseline = await this.checkpointer.captureBaseline(conversationId);

    try {
      for await (const event of this.agentExecutor.runStream(
        conversation.agentConfig,
        conversationId,
        content,
        options,
      )) {
        yield event; // 先透传给 Controller，保证流不被阻塞

        // 同步追踪消息内容，供流结束后持久化
        switch (event.type) {
          case 'tool_result':
            pendingMessages.push({
              conversationId,
              role: MessageRole.TOOL,
              content: String((event.data as { content: unknown }).content),
              toolCallId: (event.data as { callId: string }).callId,
              isError: (event.data as { isError?: boolean }).isError === true,
            });
            break;
          case 'message_end': {
            const data = event.data as {
              content: string;
              reasoning?: string | null;
              toolCalls: Message['toolCalls'];
              totalTokens?: number;
            };
            totalTokens = data.totalTokens ?? totalTokens;
            if (data.content || data.toolCalls?.length) {
              pendingMessages.push({
                conversationId,
                role: MessageRole.ASSISTANT,
                content: data.content,
                reasoning: data.reasoning ?? null,
                toolCalls: data.toolCalls?.length ? data.toolCalls : null,
              });
            }
            break;
          }
        }
      }
    } catch (e) {
      // 失败/断线时回滚本轮 checkpoint 写入（消息本就零残留），
      // 保证前端可原样重发且下一次执行不会恢复半截状态。
      // 回滚自身失败只记日志，不吞掉原始异常。
      await this.checkpointer
        .rollbackToBaseline(conversationId, baseline)
        .catch((rollbackErr: Error) => {
          this.logger.error(
            `会话 ${conversationId} 失败回滚 checkpoint 异常: ${rollbackErr.message}`,
            rollbackErr.stack,
          );
        });
      throw e;
    }

    // 流正常结束：先落 user 消息（含首条标题回填），再落本轮 agent 消息，
    // seq 自增序即消息序；token 累计值写到最后一条 assistant 消息上
    await this.persistUserMessage(conversation, content);
    if (pendingMessages.length) {
      const lastAssistant = pendingMessages.findLast((m) => m.role === MessageRole.ASSISTANT);
      if (lastAssistant) {
        lastAssistant.totalTokens = totalTokens;
      }
      await this.messageRepo.save(pendingMessages.map((m) => this.messageRepo.create(m)));
    }
  }

  async listMessages(userId: string, conversationId: string, query: QueryConversationsDto) {
    await this.loadOwnedConversation(userId, conversationId);
    const { page = 1, limit = 20 } = query;
    // DESC 分页：page=1 为最新一页，前端向上翻页取更早消息。
    // 用 seq（自增=插入序）而非 createdAt——同轮批量 INSERT 的 created_at 完全相同（见 Message.seq 注释）
    const [items, total] = await this.messageRepo.findAndCount({
      where: { conversationId },
      order: { seq: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** 删除会话：消息靠外键 CASCADE，LangGraph checkpoint 需手动清理 */
  async removeConversation(userId: string, id: string): Promise<void> {
    const conversation = await this.loadOwnedConversation(userId, id);
    await this.checkpointer.deleteThread(id);
    await this.conversationRepo.remove(conversation);
  }

  /** 校验会话归属当前用户（不带出 agentConfig，供后台任务等只读场景复用） */
  async assertOwnedConversation(userId: string, conversationId: string): Promise<void> {
    await this.loadOwnedConversation(userId, conversationId);
  }

  /** 校验会话归属当前用户，并带出 agentConfig（内部执行用，不外泄到响应） */
  private async loadOwnedConversation(
    userId: string,
    conversationId: string,
  ): Promise<Conversation> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, agentConfig: { userId } },
      relations: ['agentConfig'],
    });
    if (!conversation) {
      throw new NotFoundException(`会话 #${conversationId} 不存在`);
    }
    if (!conversation.agentConfig.isActive) {
      throw new GoneException('该 Agent 已停用');
    }
    return conversation;
  }

  /**
   * 持久化用户消息；首条消息时自动生成会话标题（前 30 字）。
   * 每次消息落库都刷新会话 updatedAt——列表按 updatedAt 倒序排列，
   * 若不 touch，新会话的第一条消息不会把它顶到列表顶部。
   */
  private async persistUserMessage(conversation: Conversation, content: string): Promise<Message> {
    const userMsg = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: conversation.id,
        role: MessageRole.USER,
        content,
      }),
    );
    // 只更新标量列：不能直接用 Partial<Conversation>（含 agentConfig 关系属性，
    // 不满足 TypeORM update 的 _QueryDeepPartialEntity 约束）
    const update: { title?: string; updatedAt: Date } = { updatedAt: new Date() };
    // 标题回填只在 title 为空时发生，touch updatedAt 每次消息都发生
    if (!conversation.title) {
      update.title = content.slice(0, TITLE_MAX_LENGTH);
    }
    await this.conversationRepo.update(conversation.id, update);
    return userMsg;
  }
}
