import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentConfig } from './entities/agent-config.entity';
import { Conversation } from './entities/conversation.entity';
import { Message, MessageRole } from './entities/message.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { AgentExecutorService } from './agent-executor.service';
import { TypeORMCheckpointer } from './checkpointers/typeorm.checkpointer';
import { SseEvent } from './agents.types';

/** 会话标题默认取首条用户消息前 30 字 */
const TITLE_MAX_LENGTH = 30;

/**
 * 会话管理与 Agent 执行入口。
 *
 * 多用户隔离：所有操作先校验会话归属（join agentConfig 比对 userId），
 * 查不到统一抛 404，不区分「不存在」与「别人的」。
 *
 * ⚠️ 并发限制：同一 conversationId 不支持并发请求（LangGraph checkpoint
 * 读改写会造成状态覆盖），前端必须保证同一会话串行发消息。
 */
@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly agentExecutor: AgentExecutorService,
    private readonly checkpointer: TypeORMCheckpointer,
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
    const [items, total] = await this.conversationRepo.findAndCount({
      where: { agentConfigId: agentId },
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
  async *streamMessages(conversation: Conversation, content: string): AsyncGenerator<SseEvent> {
    const conversationId = conversation.id;

    const pendingMessages: Partial<Message>[] = [];
    let totalTokens = 0;

    for await (const event of this.agentExecutor.runStream(
      conversation.agentConfig,
      conversationId,
      content,
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
          });
          break;
        case 'message_end': {
          const data = event.data as {
            content: string;
            toolCalls: Message['toolCalls'];
            totalTokens?: number;
          };
          totalTokens = data.totalTokens ?? totalTokens;
          if (data.content || data.toolCalls?.length) {
            pendingMessages.push({
              conversationId,
              role: MessageRole.ASSISTANT,
              content: data.content,
              toolCalls: data.toolCalls?.length ? data.toolCalls : null,
            });
          }
          break;
        }
      }
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

  /** 持久化用户消息；首条消息时自动生成会话标题（前 30 字） */
  private async persistUserMessage(conversation: Conversation, content: string): Promise<Message> {
    const userMsg = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: conversation.id,
        role: MessageRole.USER,
        content,
      }),
    );
    if (!conversation.title) {
      await this.conversationRepo.update(conversation.id, {
        title: content.slice(0, TITLE_MAX_LENGTH),
      });
    }
    return userMsg;
  }
}
