import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MemorySaver } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { AgentExecutorService } from 'src/agents/agent-executor.service';
import { ToolRegistryService } from 'src/agents/tools/tool-registry.service';
import { TypeORMCheckpointer } from 'src/agents/checkpointers/typeorm.checkpointer';
import { AGENT_ENCRYPTION_KEY } from 'src/agents/utils/encryption-key.provider';
import { encrypt } from 'src/agents/utils/crypto.util';
import { AgentConfig, ProviderType } from 'src/agents/entities/agent-config.entity';
import { MessageRole } from 'src/agents/entities/message.entity';

// 这个 mock 必须在 import 之前声明，jest.mock 会被提升到顶部
const mockInvoke = jest.fn();
const mockBindTools = jest.fn();

jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke,
    bindTools: mockBindTools,
  })),
}));

jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke,
    bindTools: mockBindTools,
  })),
}));

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const API_KEY = 'sk-test-key-123456';

describe('AgentExecutorService', () => {
  let service: AgentExecutorService;
  let toolRegistry: { getToolsForAgent: jest.Mock };

  const buildAgent = (override: Partial<AgentConfig> = {}): AgentConfig =>
    ({
      id: 'agent-1',
      userId: 'user-1',
      name: '测试助手',
      provider: ProviderType.ANTHROPIC,
      model: 'claude-opus-4-8',
      apiKeyEncrypted: encrypt(API_KEY, TEST_KEY),
      systemPrompt: null,
      maxTokens: 4096,
      maxIterations: 10,
      enabledTools: [],
      mcpServers: [],
      isActive: true,
      ...override,
    }) as AgentConfig;

  const calculatorTool = {
    name: 'calculator',
    invoke: jest.fn(async () => '42'),
  } as unknown as StructuredToolInterface;

  beforeEach(async () => {
    jest.clearAllMocks();
    toolRegistry = { getToolsForAgent: jest.fn().mockResolvedValue([]) };
    mockBindTools.mockImplementation(() => ({ invoke: mockInvoke }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutorService,
        { provide: ToolRegistryService, useValue: toolRegistry },
        // 用真实 MemorySaver 替代 TypeORMCheckpointer，让图状态流转真实发生
        {
          provide: TypeORMCheckpointer,
          useValue: new MemorySaver() as unknown as TypeORMCheckpointer,
        },
        { provide: AGENT_ENCRYPTION_KEY, useValue: TEST_KEY },
      ],
    }).compile();

    service = module.get(AgentExecutorService);
  });

  describe('run（同步执行）', () => {
    it('LLM 直接返回文本时应该不进入 tool loop', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: '你好，我是助手' }));

      const result = await service.run(buildAgent(), 'conv-1', '你好');

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { role: MessageRole.ASSISTANT, content: '你好，我是助手', toolCalls: null },
      ]);
    });

    it('tool loop：一轮工具调用后应该回到 agent_node 并结束', async () => {
      toolRegistry.getToolsForAgent.mockResolvedValue([calculatorTool]);
      mockInvoke
        .mockResolvedValueOnce(
          new AIMessage({
            content: '我先算一下',
            tool_calls: [{ id: 'call_1', name: 'calculator', args: { expression: '6*7' } }],
          }),
        )
        .mockResolvedValueOnce(new AIMessage({ content: '答案是 42' }));

      const result = await service.run(buildAgent(), 'conv-1', '6乘7等于几');

      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(calculatorTool.invoke).toHaveBeenCalledWith({ expression: '6*7' });
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        role: MessageRole.ASSISTANT,
        content: '我先算一下',
        toolCalls: [{ id: 'call_1', name: 'calculator', args: { expression: '6*7' } }],
      });
      expect(result[1]).toMatchObject({
        role: MessageRole.TOOL,
        content: '42',
        toolCallId: 'call_1',
      });
      expect(result[2]).toMatchObject({
        role: MessageRole.ASSISTANT,
        content: '答案是 42',
      });
    });

    it('达到 maxIterations 应该强制终止，不再执行工具', async () => {
      toolRegistry.getToolsForAgent.mockResolvedValue([calculatorTool]);
      mockInvoke.mockResolvedValue(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_1', name: 'calculator', args: {} }],
        }),
      );

      const result = await service.run(buildAgent({ maxIterations: 1 }), 'conv-1', '开始循环');

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(calculatorTool.invoke).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe(MessageRole.ASSISTANT);
    });

    it('工具不存在时应该把错误封装为 ToolMessage 并继续决策', async () => {
      // LLM 请求了一个未挂载的工具
      mockInvoke
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'call_1', name: 'nonexistent', args: {} }],
          }),
        )
        .mockResolvedValueOnce(new AIMessage({ content: '抱歉，我没法查' }));

      const result = await service.run(buildAgent(), 'conv-1', '查一下');

      expect(result[1]).toMatchObject({
        role: MessageRole.TOOL,
        toolCallId: 'call_1',
      });
      expect(result[1].content).toContain('未找到工具: nonexistent');
      expect(result[2].content).toBe('抱歉，我没法查');
    });

    it('工具抛异常时应该把错误信息作为工具结果返回给 LLM', async () => {
      const failingTool = {
        name: 'calculator',
        invoke: jest.fn(async () => {
          throw new Error('除零错误');
        }),
      } as unknown as StructuredToolInterface;
      toolRegistry.getToolsForAgent.mockResolvedValue([failingTool]);
      mockInvoke
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'call_1', name: 'calculator', args: {} }],
          }),
        )
        .mockResolvedValueOnce(new AIMessage({ content: '计算失败了' }));

      const result = await service.run(buildAgent(), 'conv-1', '算一下');

      expect(result[1].content).toContain('工具调用失败: 除零错误');
      expect(result[2].content).toBe('计算失败了');
    });

    it('第二轮对话不应该把历史消息重复计入返回', async () => {
      mockInvoke
        .mockResolvedValueOnce(new AIMessage({ content: '第一轮回答' }))
        .mockResolvedValueOnce(new AIMessage({ content: '第二轮回答' }));

      await service.run(buildAgent(), 'conv-1', '第一个问题');
      const second = await service.run(buildAgent(), 'conv-1', '第二个问题');

      // 只包含本轮新增的 assistant 消息，不含历史
      expect(second).toEqual([
        { role: MessageRole.ASSISTANT, content: '第二轮回答', toolCalls: null },
      ]);
    });

    it('systemPrompt 应该作为 SystemMessage 前插到模型输入', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent({ systemPrompt: '你是专业客服' }), 'conv-1', '你好');

      const inputMessages = mockInvoke.mock.calls[0][0] as {
        _getType(): string;
        content: unknown;
      }[];
      expect(inputMessages[0]._getType()).toBe('system');
      expect(inputMessages[0].content).toBe('你是专业客服');
    });
  });

  describe('createModelFromConfig', () => {
    it('openai provider 应该创建 ChatOpenAI 并传入解密后的 key', async () => {
      const { ChatOpenAI } = jest.requireMock('@langchain/openai') as {
        ChatOpenAI: jest.Mock;
      };
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(
        buildAgent({ provider: ProviderType.OPENAI, model: 'gpt-4o' }),
        'conv-1',
        '你好',
      );

      expect(ChatOpenAI).toHaveBeenCalledWith({
        apiKey: API_KEY,
        model: 'gpt-4o',
        maxTokens: 4096,
      });
    });

    it('deepseek provider 应该抛 BadRequestException', async () => {
      await expect(
        service.run(buildAgent({ provider: ProviderType.DEEPSEEK }), 'conv-1', '你好'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
