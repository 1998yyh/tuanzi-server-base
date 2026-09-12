import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException, GoneException } from '@nestjs/common';
import { StockResearchService } from 'src/stock-research/stock-research.service';
import { ResearchConversation } from 'src/stock-research/research-conversation.entity';
import { ResearchEvidenceService } from 'src/stock-research/research-evidence.service';
import { ConversationsService } from 'src/agents/conversations.service';
import { ConversationExecutionLock } from 'src/agents/utils/conversation-execution-lock';
import { AgentConfig } from 'src/agents/entities/agent-config.entity';
import { Conversation } from 'src/agents/entities/conversation.entity';
import { TypeORMCheckpointer } from 'src/agents/checkpointers/typeorm.checkpointer';
describe('AI复盘会话', () => {
  let service: StockResearchService;
  let repo: any,
    agentRepo: any,
    conversationRepo: any,
    db: any,
    conversations: any,
    evidence: any,
    lock: any;
  const dto = {
    agentId: 'a1',
    context: { kind: 'stock' as const, code: '600519', date: '2026-09-10' },
  };
  beforeEach(async () => {
    repo = { findOne: jest.fn(), create: jest.fn((v) => v), save: jest.fn(async (v) => v) };
    agentRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'a1', userId: 'u1', isActive: true }),
    };
    conversationRepo = {
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ id: 'c1', ...v })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    db = {
      getRepository: () => agentRepo,
      transaction: jest.fn(async (fn) =>
        fn({
          getRepository: (type: unknown) =>
            type === AgentConfig ? agentRepo : type === Conversation ? conversationRepo : repo,
        }),
      ),
    };
    conversations = { prepareStream: jest.fn(), removeConversation: jest.fn() };
    evidence = { snapshot: jest.fn().mockResolvedValue({ available: false, reason: '未接入' }) };
    lock = { acquire: jest.fn().mockResolvedValue(jest.fn()) };
    const mod = await Test.createTestingModule({
      providers: [
        StockResearchService,
        { provide: DataSource, useValue: db },
        { provide: getRepositoryToken(ResearchConversation), useValue: repo },
        { provide: ConversationsService, useValue: conversations },
        { provide: ConversationExecutionLock, useValue: lock },
        { provide: ResearchEvidenceService, useValue: evidence },
        { provide: TypeORMCheckpointer, useValue: { deleteThread: jest.fn() } },
      ],
    }).compile();
    service = mod.get(StockResearchService);
  });
  it('创建会话及上下文在同一个事务内，并冻结服务端证据', async () => {
    await service.create('u1', dto);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(agentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'a1', userId: 'u1' } });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c1',
        userId: 'u1',
        context: dto.context,
        evidence: { available: false, reason: '未接入' },
      }),
    );
  });
  it('取得证据时不占事务连接，写入前再次验证Agent', async () => {
    evidence.snapshot.mockImplementation(async () => {
      expect(db.transaction).not.toHaveBeenCalled();
      return { available: false };
    });
    await service.create('u1', dto);
    expect(agentRepo.findOne).toHaveBeenCalledTimes(2);
  });
  it('别人的Agent不可创建且不拉取证据', async () => {
    agentRepo.findOne.mockResolvedValue(null);
    await expect(service.create('u2', dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.save).not.toHaveBeenCalled();
  });
  it('停用Agent不能新建', async () => {
    agentRepo.findOne.mockResolvedValue({ isActive: false });
    await expect(service.create('u1', dto)).rejects.toBeInstanceOf(GoneException);
  });
  it('读取和发送都必须属于该用户研究会话', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.get('u2', 'c1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.prepare('u2', 'c1')).rejects.toBeInstanceOf(NotFoundException);
    expect(conversations.prepareStream).not.toHaveBeenCalled();
  });
  it('克隆Agent配置附加研究上下文，不更改共享Agent', async () => {
    const agent = { systemPrompt: '原提示词', id: 'a1' };
    repo.findOne.mockResolvedValue({
      conversationId: 'c1',
      userId: 'u1',
      context: dto.context,
      evidence: { available: false, reason: '未接入' },
      conversation: { id: 'c1' },
    });
    conversations.prepareStream.mockResolvedValue({ id: 'c1', agentConfig: agent });
    const prepared: any = await service.prepare('u1', 'c1');
    expect(prepared.agentConfig.systemPrompt).toContain('600519');
    expect(prepared.agentConfig.systemPrompt).toContain('未接入');
    expect(agent.systemPrompt).toBe('原提示词');
  });
  it('停用Agent的历史仍可事务删除，不调用仅允许启用Agent的旧删除入口', async () => {
    repo.findOne.mockResolvedValue({
      conversationId: 'c1',
      userId: 'u1',
      conversation: { id: 'c1' },
    });
    await service.remove('u1', 'c1');
    expect(conversationRepo.delete).toHaveBeenCalledWith({ id: 'c1' });
    expect(conversations.removeConversation).not.toHaveBeenCalled();
    expect(lock.acquire).toHaveBeenCalledWith('c1');
  });
  it('删除等待同会话正在生成的流退出', async () => {
    repo.findOne.mockResolvedValue({
      conversationId: 'c1',
      userId: 'u1',
      context: dto.context,
      evidence: {},
      conversation: { id: 'c1' },
    });
    conversations.prepareStream.mockResolvedValue({ id: 'c1', agentConfig: { systemPrompt: '' } });
    conversations.streamMessages = async function* () {
      yield { type: 'message_start', data: {} };
    };
    const stream = service.stream('u1', 'c1', '测试', new AbortController().signal);
    await stream.next();
    const deletion = service.remove('u1', 'c1');
    await Promise.resolve();
    expect(conversationRepo.delete).not.toHaveBeenCalled();
    await stream.return(undefined);
    await deletion;
    expect(conversationRepo.delete).toHaveBeenCalledWith({ id: 'c1' });
  });
});
