import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { ResearchConversation } from './research-conversation.entity';
import { ConversationsService } from '../agents/conversations.service';
import { ConversationExecutionLock } from '../agents/utils/conversation-execution-lock';
import { ResearchEvidenceService } from './research-evidence.service';
import { CreateResearchDto } from './dto/research.dto';
import { AgentConfig } from '../agents/entities/agent-config.entity';
import { Conversation, ConversationStatus } from '../agents/entities/conversation.entity';
import { contextPrompt, validateContext } from './research-context';
import { QueryConversationsDto } from '../agents/dto/query-conversations.dto';
import { SseEvent } from '../agents/agents.types';
import { TypeORMCheckpointer } from '../agents/checkpointers/typeorm.checkpointer';
import { Message } from '../agents/entities/message.entity';
@Injectable()
export class StockResearchService {
  // Serializes research prepare/send/delete; inner stream retains the existing global execution lock.
  private readonly researchLock = new ConversationExecutionLock();
  constructor(
    private readonly db: DataSource,
    @InjectRepository(ResearchConversation) private readonly repo: Repository<ResearchConversation>,
    private readonly conversations: ConversationsService,
    private readonly executionLock: ConversationExecutionLock,
    private readonly evidence: ResearchEvidenceService,
    private readonly checkpointer: TypeORMCheckpointer,
  ) {}
  async create(userId: string, dto: CreateResearchDto) {
    const context = validateContext(dto.context);
    const initial = await this.db
      .getRepository(AgentConfig)
      .findOne({ where: { id: dto.agentId, userId } });
    if (!initial) throw new NotFoundException('Agent 不存在');
    if (!initial.isActive) throw new GoneException('该 Agent 已停用');
    const evidence = await this.evidence.snapshot(userId, context);
    return this.db.transaction(async (manager) => {
      const agent = await manager
        .getRepository(AgentConfig)
        .findOne({ where: { id: dto.agentId, userId } });
      if (!agent) throw new NotFoundException('Agent 不存在');
      if (!agent.isActive) throw new GoneException('该 Agent 已停用');
      const conversations = manager.getRepository(Conversation);
      const conversation = await conversations.save(
        conversations.create({
          agentConfigId: agent.id,
          title: dto.title ?? null,
          status: ConversationStatus.ACTIVE,
        }),
      );
      const contexts = manager.getRepository(ResearchConversation);
      const row = await contexts.save(
        contexts.create({ conversationId: conversation.id, userId, context, evidence }),
      );
      return this.view({ ...row, conversation });
    });
  }
  private view(row: ResearchConversation) {
    return {
      id: row.conversationId,
      conversationId: row.conversationId,
      title: row.conversation.title,
      context: row.context,
      evidence: row.evidence,
      createdAt: row.createdAt,
      updatedAt: row.conversation.updatedAt,
    };
  }
  private async owned(userId: string, id: string) {
    const row = await this.repo.findOne({
      where: { conversationId: id, userId, conversation: { agentConfig: { userId } } },
      relations: ['conversation', 'conversation.agentConfig'],
    });
    if (!row) throw new NotFoundException('研究会话不存在');
    return row;
  }
  async get(userId: string, id: string) {
    return this.view(await this.owned(userId, id));
  }
  async list(userId: string, query: QueryConversationsDto) {
    const page = query.page ?? 1,
      limit = query.limit ?? 20;
    const [rows, total] = await this.repo.findAndCount({
      where: {
        userId,
        conversation: { agentConfig: { userId }, status: Not(ConversationStatus.ARCHIVED) },
      },
      relations: ['conversation'],
      order: { conversation: { updatedAt: 'DESC' }, conversationId: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: rows.map((r) => this.view(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
  async prepare(userId: string, id: string): Promise<Conversation> {
    const row = await this.owned(userId, id);
    const conversation = await this.conversations.prepareStream(userId, id);
    return {
      ...conversation,
      agentConfig: {
        ...conversation.agentConfig,
        systemPrompt: [
          conversation.agentConfig.systemPrompt,
          contextPrompt(row.context, row.evidence),
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    };
  }
  async *stream(
    userId: string,
    id: string,
    content: string,
    signal: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    const release = await this.researchLock.acquire(id);
    try {
      if (signal.aborted) return;
      const conversation = await this.prepare(userId, id);
      yield* this.conversations.streamMessages(conversation, content, { signal });
    } finally {
      release();
    }
  }
  async remove(userId: string, id: string): Promise<void> {
    const release = await this.researchLock.acquire(id);
    let releaseExecution: (() => void) | undefined;
    try {
      await this.owned(userId, id);
      releaseExecution = await this.executionLock.acquire(id);
      await this.db.transaction(async (manager) => {
        await this.checkpointer.deleteThread(id, manager);
        await manager.getRepository(Conversation).delete({ id });
      });
    } finally {
      releaseExecution?.();
      release();
    }
  }
  async messages(userId: string, id: string, query: QueryConversationsDto) {
    await this.owned(userId, id);
    const page = query.page ?? 1,
      limit = query.limit ?? 20;
    const [items, total] = await this.db.getRepository(Message).findAndCount({
      where: { conversationId: id },
      order: { seq: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
