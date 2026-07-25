import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GoneException, NotFoundException } from '@nestjs/common';
import { ConversationsService } from 'src/agents/conversations.service';
import { AgentConfig, ProviderType } from 'src/agents/entities/agent-config.entity';
import { Conversation } from 'src/agents/entities/conversation.entity';
import { Message, MessageRole } from 'src/agents/entities/message.entity';
import { AgentExecutorService } from 'src/agents/agent-executor.service';
import { TypeORMCheckpointer } from 'src/agents/checkpointers/typeorm.checkpointer';
import { SseEvent } from 'src/agents/agents.types';

describe('ConversationsService', () => {
  let service: ConversationsService;
  let agentRepo: jest.Mocked<Repository<AgentConfig>>;
  let conversationRepo: jest.Mocked<Repository<Conversation>>;
  let messageRepo: jest.Mocked<Repository<Message>>;
  let executor: { run: jest.Mock; runStream: jest.Mock };
  let checkpointer: { deleteThread: jest.Mock };

  const agent: AgentConfig = {
    id: 'agent-1',
    userId: 'user-1',
    name: '助手',
    provider: ProviderType.ANTHROPIC,
    model: 'claude-opus-4-8',
    apiKeyEncrypted: 'encrypted',
    isActive: true,
  } as AgentConfig;

  const conversation: Conversation = {
    id: 'conv-1',
    agentConfigId: 'agent-1',
    agentConfig: agent,
    title: null,
  } as Conversation;

  beforeEach(async () => {
    executor = { run: jest.fn(), runStream: jest.fn() };
    checkpointer = { deleteThread: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationsService,
        {
          provide: getRepositoryToken(AgentConfig),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: {
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => v),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Message),
          useValue: {
            findAndCount: jest.fn(),
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => v),
          },
        },
        { provide: AgentExecutorService, useValue: executor },
        { provide: TypeORMCheckpointer, useValue: checkpointer },
      ],
    }).compile();

    service = module.get(ConversationsService);
    agentRepo = module.get(getRepositoryToken(AgentConfig));
    conversationRepo = module.get(getRepositoryToken(Conversation));
    messageRepo = module.get(getRepositoryToken(Message));
  });

  describe('createConversation', () => {
    it('应该校验 Agent 归属并创建会话', async () => {
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.createConversation('user-1', 'agent-1', {});

      expect(agentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1', userId: 'user-1' },
      });
      expect(result.agentConfigId).toBe('agent-1');
    });

    it('他人的 Agent 应该抛 404', async () => {
      agentRepo.findOne.mockResolvedValue(null);
      await expect(service.createConversation('other', 'agent-1', {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('停用的 Agent 应该抛 410', async () => {
      agentRepo.findOne.mockResolvedValue({ ...agent, isActive: false });
      await expect(service.createConversation('user-1', 'agent-1', {})).rejects.toThrow(
        GoneException,
      );
    });
  });

  describe('sendMessage', () => {
    it('应该先持久化用户消息，再执行 Agent，最后批量持久化 agent 消息', async () => {
      conversationRepo.findOne.mockResolvedValue({ ...conversation });
      executor.run.mockResolvedValue([
        { role: MessageRole.ASSISTANT, content: '你好，有什么可以帮你？', toolCalls: null },
      ]);

      const result = await service.sendMessage('user-1', 'conv-1', '你好');

      expect(executor.run).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-1' }),
        'conv-1',
        '你好',
      );
      expect(messageRepo.save).toHaveBeenCalledTimes(2);
      expect(result.userMessage.role).toBe(MessageRole.USER);
      expect(result.agentMessages).toHaveLength(1);
    });

    it('首条消息应该自动截取前 30 字作为会话标题', async () => {
      conversationRepo.findOne.mockResolvedValue({ ...conversation, title: null });
      executor.run.mockResolvedValue([]);
      const longContent = '这是一条超过三十个字的用户消息，用来验证标题截取逻辑是否正常工作';

      await service.sendMessage('user-1', 'conv-1', longContent);

      expect(conversationRepo.update).toHaveBeenCalledWith('conv-1', {
        title: longContent.slice(0, 30),
      });
    });

    it('已有标题的会话不应该覆盖标题', async () => {
      conversationRepo.findOne.mockResolvedValue({ ...conversation, title: '旧标题' });
      executor.run.mockResolvedValue([]);

      await service.sendMessage('user-1', 'conv-1', '新消息');

      expect(conversationRepo.update).not.toHaveBeenCalled();
    });

    it('他人的会话应该抛 404', async () => {
      conversationRepo.findOne.mockResolvedValue(null);
      await expect(service.sendMessage('other', 'conv-1', '你好')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('Agent 停用时应该抛 410', async () => {
      conversationRepo.findOne.mockResolvedValue({
        ...conversation,
        agentConfig: { ...agent, isActive: false },
      });
      await expect(service.sendMessage('user-1', 'conv-1', '你好')).rejects.toThrow(GoneException);
    });
  });

  describe('流式聊天', () => {
    it('prepareStream 校验失败应该在流开始前抛错（不落库）', async () => {
      conversationRepo.findOne.mockResolvedValue(null);
      await expect(service.prepareStream('other', 'conv-1')).rejects.toThrow(NotFoundException);
      expect(messageRepo.save).not.toHaveBeenCalled();
    });

    it('prepareStream 只做校验，不应该落库 user 消息', async () => {
      conversationRepo.findOne.mockResolvedValue({ ...conversation });

      await service.prepareStream('user-1', 'conv-1');

      expect(messageRepo.save).not.toHaveBeenCalled();
    });

    it('streamMessages 应该透传事件并在流结束后统一持久化（user + agent 消息）', async () => {
      // 真实事件序：tool_use 发生在 message_end 之后，
      // assistant 消息以 message_end 携带的最终内容为准
      const events: SseEvent[] = [
        { type: 'message_start', data: { role: 'assistant' } },
        { type: 'text_delta', data: { text: '我先查一下' } },
        {
          type: 'message_end',
          data: {
            content: '我先查一下',
            toolCalls: [{ id: 'call_1', name: 'web_search', args: { query: 'AAPL' } }],
            conversationId: 'conv-1',
            totalTokens: 100,
          },
        },
        {
          type: 'tool_use',
          data: { id: 'call_1', name: 'web_search', args: { query: 'AAPL' } },
        },
        {
          type: 'tool_result',
          data: { callId: 'call_1', name: 'web_search', content: '{"price":198.5}' },
        },
        { type: 'message_start', data: { role: 'assistant' } },
        { type: 'text_delta', data: { text: '最新股价 198.5' } },
        {
          type: 'message_end',
          data: {
            content: '最新股价 198.5',
            toolCalls: null,
            conversationId: 'conv-1',
            totalTokens: 200,
          },
        },
      ];
      executor.runStream.mockReturnValue(
        (async function* () {
          for (const e of events) yield e;
        })(),
      );

      const received: SseEvent[] = [];
      for await (const e of service.streamMessages(conversation, '查股价')) {
        received.push(e);
      }

      expect(received).toHaveLength(events.length);

      // 第一次 save：user 消息（落库时机后移到流正常结束，含标题回填）
      expect(messageRepo.save).toHaveBeenCalledTimes(2);
      expect(messageRepo.save.mock.calls[0][0]).toMatchObject({
        role: MessageRole.USER,
        content: '查股价',
      });
      expect(conversationRepo.update).toHaveBeenCalledWith('conv-1', { title: '查股价' });

      // 第二次 save：assistant(带 toolCalls) + tool + assistant = 3 条
      const savedMessages = messageRepo.save.mock.calls[1][0] as Partial<Message>[];
      expect(savedMessages).toHaveLength(3);
      expect(savedMessages[0]).toMatchObject({
        role: MessageRole.ASSISTANT,
        content: '我先查一下',
        toolCalls: [{ id: 'call_1', name: 'web_search', args: { query: 'AAPL' } }],
      });
      expect(savedMessages[1]).toMatchObject({
        role: MessageRole.TOOL,
        toolCallId: 'call_1',
      });
      expect(savedMessages[2]).toMatchObject({
        role: MessageRole.ASSISTANT,
        content: '最新股价 198.5',
      });
      // token 跨轮累计值只写在本轮最后一条 assistant 消息上
      expect(savedMessages[0].totalTokens).toBeUndefined();
      expect(savedMessages[2].totalTokens).toBe(200);
    });

    it('流正常结束但没有 agent 消息时，只落 user 消息', async () => {
      executor.runStream.mockReturnValue((async function* () {})());

      for await (const _ of service.streamMessages(conversation, '你好')) {
        // 消费空流
      }

      expect(messageRepo.save).toHaveBeenCalledTimes(1);
      expect(messageRepo.save.mock.calls[0][0]).toMatchObject({
        role: MessageRole.USER,
        content: '你好',
      });
    });

    it('已有标题的会话不应该覆盖标题', async () => {
      executor.runStream.mockReturnValue((async function* () {})());

      for await (const _ of service.streamMessages({ ...conversation, title: '旧标题' }, '你好')) {
        // 消费空流
      }

      expect(conversationRepo.update).not.toHaveBeenCalled();
    });

    it('流中途异常不应该落库任何消息（展示层零残留）', async () => {
      executor.runStream.mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: '半截话' } } as SseEvent;
          throw new Error('LLM 连接中断');
        })(),
      );

      await expect(async () => {
        for await (const _ of service.streamMessages(conversation, '你好')) {
          // 消费到异常
        }
      }).rejects.toThrow('LLM 连接中断');

      expect(messageRepo.save).not.toHaveBeenCalled();
      expect(conversationRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('listMessages', () => {
    it('应该按 seq 倒序分页（最新在前）', async () => {
      conversationRepo.findOne.mockResolvedValue({ ...conversation });
      messageRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.listMessages('user-1', 'conv-1', { page: 1, limit: 20 });

      expect(messageRepo.findAndCount).toHaveBeenCalledWith({
        where: { conversationId: 'conv-1' },
        order: { seq: 'DESC' },
        skip: 0,
        take: 20,
      });
    });
  });

  describe('removeConversation', () => {
    it('应该先清理 checkpoint 再删会话', async () => {
      conversationRepo.findOne.mockResolvedValue({ ...conversation });

      await service.removeConversation('user-1', 'conv-1');

      expect(checkpointer.deleteThread).toHaveBeenCalledWith('conv-1');
      expect(conversationRepo.remove).toHaveBeenCalled();
    });
  });
});
