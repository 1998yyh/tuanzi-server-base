import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SystemMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { LlmService } from './llm.service';

// 这个SB mock 必须在 import 之前声明，jest.mock 会被提升到顶部
const mockInvoke = jest.fn();
const mockStream = jest.fn();
const mockBindTools = jest.fn();

jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke,
    stream: mockStream,
    bindTools: mockBindTools,
  })),
}));

describe('LlmService', () => {
  let service: LlmService;

  const mockConfig: Record<string, string> = {
    ANTHROPIC_API_KEY: 'test-api-key',
    LLM_DEFAULT_MODEL: 'claude-opus-4-8',
    LLM_MAX_TOKENS: '4096',
  };

  const createModule = async (config: Record<string, string> = mockConfig) => {
    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: unknown) => config[key] ?? defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [LlmService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    return module.get<LlmService>(LlmService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    service = await createModule();
  });

  describe('chat', () => {
    it('应该正常返回并正确映射 content / model / usage 字段', async () => {
      mockInvoke.mockResolvedValue({
        content: '你好，团子',
        response_metadata: { model: 'claude-opus-4-8' },
        usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      });

      const result = await service.chat([{ role: 'user', content: '你好' }]);

      expect(result).toEqual({
        content: '你好，团子',
        model: 'claude-opus-4-8',
        usage: { inputTokens: 10, outputTokens: 20 },
      });
    });

    it('system 消息应该被转换为 SystemMessage', async () => {
      mockInvoke.mockResolvedValue({ content: 'ok', response_metadata: {} });

      await service.chat([
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ]);

      const messages = mockInvoke.mock.calls[0][0];
      expect(messages[0]).toBeInstanceOf(SystemMessage);
    });

    it('传入 tools 时应该调用 bindTools 并将 inputSchema 映射为 input_schema', async () => {
      const boundModel = { invoke: mockInvoke };
      mockBindTools.mockReturnValue(boundModel);
      mockInvoke.mockResolvedValue({ content: 'ok', response_metadata: {} });

      await service.chat([{ role: 'user', content: '查股票' }], {
        tools: [
          {
            name: 'get_stock',
            description: '查询股票行情',
            inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
          },
        ],
      });

      expect(mockBindTools).toHaveBeenCalledWith([
        {
          name: 'get_stock',
          description: '查询股票行情',
          input_schema: { type: 'object', properties: { symbol: { type: 'string' } } },
        },
      ]);
    });

    it('响应中的 tool_use block 应该被丢弃，content 只含文本', async () => {
      mockInvoke.mockResolvedValue({
        content: [
          { type: 'text', text: '分析结果' },
          { type: 'tool_use', id: 'tool_1', name: 'get_stock', input: {} },
          { type: 'text', text: '，完毕' },
        ],
        response_metadata: { model: 'claude-opus-4-8' },
      });

      const result = await service.chat([{ role: 'user', content: '分析一下' }]);

      expect(result.content).toBe('分析结果，完毕');
    });

    it('options.model / options.maxTokens 覆盖时应该创建新的模型实例', async () => {
      mockInvoke.mockResolvedValue({ content: 'ok', response_metadata: {} });

      await service.chat([{ role: 'user', content: '你好' }], {
        model: 'claude-haiku-4-5',
        maxTokens: 1024,
      });

      const MockedChatAnthropic = ChatAnthropic as unknown as jest.Mock;
      // 构造时一次（默认实例）+ 覆盖时一次
      expect(MockedChatAnthropic).toHaveBeenCalledTimes(2);
      expect(MockedChatAnthropic).toHaveBeenLastCalledWith({
        apiKey: 'test-api-key',
        model: 'claude-haiku-4-5',
        maxTokens: 1024,
      });
    });
  });

  describe('chatStream', () => {
    it('应该逐 chunk yield 文本并正确拼接', async () => {
      mockStream.mockResolvedValue(
        (async function* () {
          yield { content: '你好' };
          yield { content: [{ type: 'text', text: '，世界' }] };
          yield { content: '' };
        })(),
      );

      const chunks: string[] = [];
      for await (const text of service.chatStream([{ role: 'user', content: '你好' }])) {
        chunks.push(text);
      }

      expect(chunks).toEqual(['你好', '，世界']);
    });
  });

  describe('构造函数', () => {
    it('ANTHROPIC_API_KEY 缺失时应该抛错（fail-fast）', async () => {
      await expect(createModule({ ...mockConfig, ANTHROPIC_API_KEY: '' })).rejects.toThrow(
        'ANTHROPIC_API_KEY 未配置，LlmService 无法初始化',
      );
    });
  });
});
