import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { ConversationsController } from 'src/agents/conversations.controller';
import { ConversationsService } from 'src/agents/conversations.service';
import { Conversation } from 'src/agents/entities/conversation.entity';
import { SseEvent } from 'src/agents/agents.types';
import { UserRole } from 'src/users/users.entity';

describe('ConversationsController', () => {
  let controller: ConversationsController;
  let service: jest.Mocked<ConversationsService>;

  const mockUser = {
    id: 'user-1',
    email: 'u@test.com',
    username: 'user',
    role: UserRole.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createMockRes = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      json: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    return res as unknown as Response & {
      status: jest.Mock;
      setHeader: jest.Mock;
      write: jest.Mock;
      end: jest.Mock;
      json: jest.Mock;
      on: jest.Mock;
      removeListener: jest.Mock;
    };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConversationsController],
      providers: [
        {
          provide: ConversationsService,
          useValue: {
            createConversation: jest.fn(),
            listConversations: jest.fn(),
            sendMessage: jest.fn(),
            prepareStream: jest.fn(),
            streamMessages: jest.fn(),
            listMessages: jest.fn(),
            removeConversation: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(ConversationsController);
    service = module.get(ConversationsService);
  });

  describe('sendMessage 同步模式', () => {
    it('应该返回 201 与完整消息结果', async () => {
      const res = createMockRes();
      const result = { userMessage: { id: 'm1' }, agentMessages: [] };
      service.sendMessage.mockResolvedValue(result as never);

      await controller.sendMessage(mockUser, 'conv-1', { content: '你好' }, '', res);

      expect(service.sendMessage).toHaveBeenCalledWith('user-1', 'conv-1', '你好');
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(result);
    });
  });

  describe('sendMessage SSE 模式', () => {
    it('prepareStream 校验失败时不应该发送 SSE 响应头', async () => {
      const res = createMockRes();
      service.prepareStream.mockRejectedValue(new NotFoundException('会话不存在'));

      await expect(
        controller.sendMessage(mockUser, 'conv-1', { content: '你好' }, 'true', res),
      ).rejects.toThrow(NotFoundException);

      // 关键时序：抛错发生在 setHeader 之前，前端拿到的是正常 JSON 错误
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
    });

    it('正常流程应该设置 SSE 响应头并逐事件写入', async () => {
      const res = createMockRes();
      const conversation = { id: 'conv-1' } as Conversation;
      service.prepareStream.mockResolvedValue(conversation);
      const events: SseEvent[] = [
        { type: 'message_start', data: { role: 'assistant' } },
        { type: 'text_delta', data: { text: '你好' } },
      ];
      service.streamMessages.mockReturnValue(
        (async function* () {
          for (const e of events) yield e;
        })(),
      );

      await controller.sendMessage(mockUser, 'conv-1', { content: '你好' }, 'true', res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.write).toHaveBeenCalledWith(
        `event: message_start\ndata: ${JSON.stringify({ role: 'assistant' })}\n\n`,
      );
      expect(res.write).toHaveBeenCalledWith(
        `event: text_delta\ndata: ${JSON.stringify({ text: '你好' })}\n\n`,
      );
      expect(res.end).toHaveBeenCalled();
    });

    it('流式执行中途异常应该发送 error 事件后关闭流', async () => {
      const res = createMockRes();
      const conversation = { id: 'conv-1' } as Conversation;
      service.prepareStream.mockResolvedValue(conversation);
      service.streamMessages.mockReturnValue(
        (async function* () {
          yield { type: 'message_start', data: { role: 'assistant' } } as SseEvent;
          throw new Error('LLM 连接断开');
        })(),
      );

      await controller.sendMessage(mockUser, 'conv-1', { content: '你好' }, 'true', res);

      expect(res.write).toHaveBeenCalledTimes(2);
      expect(res.write).toHaveBeenLastCalledWith(expect.stringMatching(/^event: error\ndata: /));
      expect(res.end).toHaveBeenCalled();
    });

    it('应该把 AbortSignal 传给 streamMessages，用于客户端断线时中止执行', async () => {
      const res = createMockRes();
      service.prepareStream.mockResolvedValue({ id: 'conv-1' } as Conversation);
      service.streamMessages.mockReturnValue((async function* () {})());

      await controller.sendMessage(mockUser, 'conv-1', { content: '你好' }, 'true', res);

      expect(service.streamMessages).toHaveBeenCalledWith(
        { id: 'conv-1' },
        '你好',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      // 注册了 close 监听，结束时移除
      expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(res.removeListener).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('客户端断开（close 触发 abort）后应停止写入 SSE 并正常收尾', async () => {
      const res = createMockRes();
      service.prepareStream.mockResolvedValue({ id: 'conv-1' } as Conversation);
      service.streamMessages.mockReturnValue(
        (async function* () {
          yield { type: 'message_start', data: { role: 'assistant' } } as SseEvent;
          // 模拟客户端断线：触发 close 回调 → AbortController.abort()
          const onClose = res.on.mock.calls.find((c) => c[0] === 'close')?.[1] as
            | (() => void)
            | undefined;
          onClose?.();
          // abort 后循环应在写之前 break，这条事件不应被写出
          yield { type: 'text_delta', data: { text: '不该写出来' } } as SseEvent;
        })(),
      );

      await controller.sendMessage(mockUser, 'conv-1', { content: '你好' }, 'true', res);

      expect(res.write).toHaveBeenCalledTimes(1);
      expect(res.end).toHaveBeenCalled();
    });
  });
});
