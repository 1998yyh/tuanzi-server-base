import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MemorySaver } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { AgentExecutorService } from 'src/agents/agent-executor.service';
import { ToolRegistryService } from 'src/agents/tools/tool-registry.service';
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
import { SkillToolFactory } from 'src/skills/skill-tool.factory';
import { DelegateToolFactory } from 'src/agents/tools/delegate-tool.factory';
import { TypeORMCheckpointer } from 'src/agents/checkpointers/typeorm.checkpointer';
import { AGENT_ENCRYPTION_KEY } from 'src/agents/utils/encryption-key.provider';
import { AgentConfig } from 'src/agents/entities/agent-config.entity';
import { MessageRole } from 'src/agents/entities/message.entity';
import { AiChannelsService } from 'src/ai-generation/ai-channels.service';
import { ApiFormat } from 'src/ai-generation/entities/ai-channel.entity';

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
  let mcpServersService: { findByAgentConfig: jest.Mock };
  let skillToolFactory: { createToolsForAgent: jest.Mock };
  let aiChannelsService: jest.Mocked<AiChannelsService>;

  const buildAgent = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
    ({
      id: 'agent-1',
      userId: 'user-1',
      name: '测试 Agent',
      channelId: 'ch-1',
      modelName: 'claude-opus-4-8',
      maxTokens: 4096,
      maxIterations: 10,
      enabledTools: [],
      isActive: true,
      ...overrides,
    }) as AgentConfig;

  const calculatorTool = {
    name: 'calculator',
    invoke: jest.fn(async () => '42'),
  } as unknown as StructuredToolInterface;

  beforeEach(async () => {
    jest.clearAllMocks();
    toolRegistry = { getToolsForAgent: jest.fn().mockResolvedValue([]) };
    mcpServersService = { findByAgentConfig: jest.fn().mockResolvedValue([]) };
    skillToolFactory = { createToolsForAgent: jest.fn().mockResolvedValue([]) };
    mockBindTools.mockImplementation(() => ({ invoke: mockInvoke }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutorService,
        { provide: ToolRegistryService, useValue: toolRegistry },
        { provide: McpServersService, useValue: mcpServersService },
        { provide: SkillToolFactory, useValue: skillToolFactory },
        // 子代理委派工厂：测试路径不触发委派，createTool 返回占位即可
        { provide: DelegateToolFactory, useValue: { createTool: jest.fn() } },
        // 用真实 MemorySaver 替代 TypeORMCheckpointer，让图状态流转真实发生
        {
          provide: TypeORMCheckpointer,
          useValue: new MemorySaver() as unknown as TypeORMCheckpointer,
        },
        { provide: AGENT_ENCRYPTION_KEY, useValue: TEST_KEY },
        {
          provide: AiChannelsService,
          useValue: {
            resolveChatModel: jest.fn(
              async (_userId: string, channelId: string, modelName: string) => ({
                channelId,
                apiFormat: ApiFormat.OPENAI,
                baseUrl: 'https://api.openai.com',
                apiKey: API_KEY,
                model: modelName,
              }),
            ),
          },
        },
      ],
    }).compile();

    service = module.get(AgentExecutorService);
    aiChannelsService = module.get(AiChannelsService);
  });

  describe('run（同步执行）', () => {
    it('LLM 直接返回文本时应该不进入 tool loop', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: '你好，我是助手' }));

      const result = await service.run(buildAgent(), 'conv-1', '你好');

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          role: MessageRole.ASSISTANT,
          content: '你好，我是助手',
          reasoning: null,
          toolCalls: null,
          totalTokens: null,
        },
      ]);
    });

    it('assistant 消息应该携带跨条累计的 token 用量', async () => {
      toolRegistry.getToolsForAgent.mockResolvedValue([calculatorTool]);
      mockInvoke
        .mockResolvedValueOnce(
          new AIMessage({
            content: '我先算一下',
            tool_calls: [{ id: 'call_1', name: 'calculator', args: { expression: '6*7' } }],
            usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
        )
        .mockResolvedValueOnce(
          new AIMessage({
            content: '答案是 42',
            usage_metadata: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
          }),
        );

      const result = await service.run(buildAgent(), 'conv-1', '6乘7等于几');

      // 第一条 assistant 累计 15，最后一条累计 15+25=40（= 本轮总消耗）
      expect(result[0].totalTokens).toBe(15);
      expect(result[2].totalTokens).toBe(40);
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
      // 第二参经 metadata 透传 tool_call_id（SSE 事件配对），并携带中止 signal
      expect(calculatorTool.invoke).toHaveBeenCalledWith(
        { expression: '6*7' },
        expect.objectContaining({
          metadata: { tool_call_id: 'call_1' },
          signal: expect.any(AbortSignal),
        }),
      );
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

    it('工具抛未知异常时应该脱敏为通用文案（内部细节不进消息表），完整错误进服务端日志', async () => {
      const failingTool = {
        name: 'calculator',
        invoke: jest.fn(async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:3389');
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
      const loggerErrorSpy = jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined);

      const result = await service.run(buildAgent(), 'conv-1', '算一下');

      expect(result[1].content).toBe('工具执行失败，请稍后重试');
      expect(result[1].content).not.toContain('ECONNREFUSED');
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('工具执行异常: connect ECONNREFUSED'),
        expect.stringContaining('Error'),
      );
      loggerErrorSpy.mockRestore();
    });

    it('工具抛 HttpException 时应保留中文业务文案喂给 LLM', async () => {
      const failingTool = {
        name: 'calculator',
        invoke: jest.fn(async () => {
          throw new BadRequestException('任务间隔不能少于 1 小时');
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
        .mockResolvedValueOnce(new AIMessage({ content: '明白了' }));

      const result = await service.run(buildAgent(), 'conv-1', '建个任务');

      expect(result[1].content).toBe('任务间隔不能少于 1 小时');
    });

    it('工具超时后应中止底层执行（signal.aborted=true）并把超时文案喂给 LLM', async () => {
      jest.useFakeTimers();
      try {
        let capturedSignal: AbortSignal | undefined;
        const hangingTool = {
          name: 'calculator',
          invoke: jest.fn(async (_args: unknown, config: { signal?: AbortSignal }) => {
            capturedSignal = config?.signal;
            // 一直挂起直到被 abort
            await new Promise<void>((resolve) => {
              const poll = () => {
                if (capturedSignal?.aborted) resolve();
                else setTimeout(poll, 10);
              };
              poll();
            });
            return '最终完成';
          }),
        } as unknown as StructuredToolInterface;
        toolRegistry.getToolsForAgent.mockResolvedValue([hangingTool]);
        mockInvoke
          .mockResolvedValueOnce(
            new AIMessage({
              content: '',
              tool_calls: [{ id: 'call_1', name: 'calculator', args: {} }],
            }),
          )
          .mockResolvedValueOnce(new AIMessage({ content: '超时了，稍后再说' }));

        const runPromise = service.run(buildAgent(), 'conv-1', '算一下');
        await jest.advanceTimersByTimeAsync(30_000);
        const result = await runPromise;

        expect(capturedSignal?.aborted).toBe(true);
        expect(result[1].content).toBe('工具调用超时（30s）');
        expect(result[2].content).toBe('超时了，稍后再说');
      } finally {
        jest.useRealTimers();
      }
    });

    it('第二轮对话不应该把历史消息重复计入返回', async () => {
      mockInvoke
        .mockResolvedValueOnce(new AIMessage({ content: '第一轮回答' }))
        .mockResolvedValueOnce(new AIMessage({ content: '第二轮回答' }));

      await service.run(buildAgent(), 'conv-1', '第一个问题');
      const second = await service.run(buildAgent(), 'conv-1', '第二个问题');

      // 只包含本轮新增的 assistant 消息，不含历史
      expect(second).toEqual([
        {
          role: MessageRole.ASSISTANT,
          content: '第二轮回答',
          reasoning: null,
          toolCalls: null,
          totalTokens: null,
        },
      ]);
    });

    it('systemPrompt 应该拼接时间戳元数据后作为 SystemMessage 前插到模型输入', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent({ systemPrompt: '你是专业客服' }), 'conv-1', '你好');

      const inputMessages = mockInvoke.mock.calls[0][0] as {
        _getType(): string;
        content: unknown;
      }[];
      expect(inputMessages[0]._getType()).toBe('system');
      expect(inputMessages[0].content).toMatch(
        /^你是专业客服\n\ntimestamp="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00"$/,
      );
    });

    it('未配置 systemPrompt 时也应该注入时间戳元数据', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent(), 'conv-1', '现在几点');

      const inputMessages = mockInvoke.mock.calls[0][0] as {
        _getType(): string;
        content: unknown;
      }[];
      expect(inputMessages[0]._getType()).toBe('system');
      expect(inputMessages[0].content).toMatch(
        /^timestamp="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00"$/,
      );
    });

    it('应该从 McpServersService 加载 MCP 工具并传给 ToolRegistry', async () => {
      const runtimeServer = { name: '远程工具', type: 'sse', url: 'https://mcp.example.com/sse' };
      mcpServersService.findByAgentConfig.mockResolvedValue([runtimeServer]);
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent(), 'conv-1', '你好');

      expect(mcpServersService.findByAgentConfig).toHaveBeenCalledWith('agent-1');
      expect(toolRegistry.getToolsForAgent).toHaveBeenCalledWith(expect.anything(), [
        runtimeServer,
      ]);
    });

    it('正常执行应该把 Skill 工具追加进工具列表', async () => {
      const skillTool = { name: 'generate_ai_report', invoke: jest.fn() };
      skillToolFactory.createToolsForAgent.mockResolvedValue([skillTool]);
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent(), 'conv-1', '你好');

      expect(skillToolFactory.createToolsForAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          runBatch: expect.any(Function),
          buildSubTools: expect.any(Function),
        }),
      );
      expect(mockBindTools).toHaveBeenCalledWith([skillTool]);
    });

    it('Skill 工具与内置/MCP 工具同名时应该跳过，避免 bindTools 重名报错', async () => {
      const mcpTool = { name: 'generate_ai_report', invoke: jest.fn() };
      const dupSkillTool = { name: 'generate_ai_report', invoke: jest.fn() };
      const uniqueSkillTool = { name: 'generate_stock_report', invoke: jest.fn() };
      toolRegistry.getToolsForAgent.mockResolvedValue([mcpTool]);
      skillToolFactory.createToolsForAgent.mockResolvedValue([dupSkillTool, uniqueSkillTool]);
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent(), 'conv-1', '你好');

      expect(mockBindTools).toHaveBeenCalledWith([mcpTool, uniqueSkillTool]);
    });

    it('isSkillExecution=true 时不应该注入 Skill 工具（防递归）', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.runBatch(buildAgent(), '执行任务', { isSkillExecution: true });

      expect(skillToolFactory.createToolsForAgent).not.toHaveBeenCalled();
    });
  });

  describe('runBatch（批量执行）', () => {
    it('带 threadId 且无覆盖项时应该走 checkpoint（等价 run）', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: '批量回答' }));

      const result = await service.runBatch(buildAgent(), '生成日报', { threadId: 'conv-9' });

      expect(toolRegistry.getToolsForAgent).toHaveBeenCalled();
      expect(result).toEqual([
        {
          role: MessageRole.ASSISTANT,
          content: '批量回答',
          reasoning: null,
          toolCalls: null,
          totalTokens: null,
        },
      ]);
    });

    it('无 threadId 时应该一次性执行，不写 checkpoint 且只返回本轮消息', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: '子 Agent 输出' }));

      const result = await service.runBatch(buildAgent(), '执行任务');

      expect(result).toEqual([
        {
          role: MessageRole.ASSISTANT,
          content: '子 Agent 输出',
          reasoning: null,
          toolCalls: null,
          totalTokens: null,
        },
      ]);
    });

    it('overrideSystemPrompt 应该替代 Agent 自身的 systemPrompt', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.runBatch(buildAgent({ systemPrompt: '原始提示词' }), '执行任务', {
        overrideSystemPrompt: 'Skill 的执行指令',
      });

      const inputMessages = mockInvoke.mock.calls[0][0] as {
        _getType(): string;
        content: unknown;
      }[];
      expect(inputMessages[0]._getType()).toBe('system');
      expect(inputMessages[0].content).toContain('Skill 的执行指令');
      expect(inputMessages[0].content).not.toContain('原始提示词');
    });

    it('overrideTools 时不应该再加载 Agent 工具', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.runBatch(buildAgent(), '执行任务', { overrideTools: [calculatorTool] });

      expect(toolRegistry.getToolsForAgent).not.toHaveBeenCalled();
      expect(mockBindTools).toHaveBeenCalledWith([calculatorTool]);
    });
  });

  describe('createModelFromConfig（按渠道解析）', () => {
    it('用 agent 的 userId/channelId/modelName 调 resolveChatModel', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent({ channelId: 'ch-9', modelName: 'gpt-5' }), 'thread-1', 'hi');

      expect(aiChannelsService.resolveChatModel).toHaveBeenCalledWith('user-1', 'ch-9', 'gpt-5');
    });

    it('openai 格式渠道创建 ChatOpenAI 并传 baseURL', async () => {
      const { ChatOpenAI } = jest.requireMock('@langchain/openai') as { ChatOpenAI: jest.Mock };
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent({ modelName: 'gpt-5' }), 'thread-1', 'hi');

      expect(ChatOpenAI).toHaveBeenCalledWith({
        apiKey: API_KEY,
        model: 'gpt-5',
        maxTokens: 4096,
        configuration: { baseURL: 'https://api.openai.com' },
      });
    });

    it('anthropic 格式渠道创建 ChatAnthropic 并传 anthropicApiUrl', async () => {
      aiChannelsService.resolveChatModel.mockResolvedValueOnce({
        channelId: 'ch-1',
        apiFormat: ApiFormat.ANTHROPIC,
        baseUrl: 'https://api.anthropic.com',
        apiKey: API_KEY,
        model: 'claude-opus-4-8',
      });
      const { ChatAnthropic } = jest.requireMock('@langchain/anthropic') as {
        ChatAnthropic: jest.Mock;
      };
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent(), 'thread-1', 'hi');

      expect(ChatAnthropic).toHaveBeenCalledWith({
        apiKey: API_KEY,
        model: 'claude-opus-4-8',
        maxTokens: 4096,
        anthropicApiUrl: 'https://api.anthropic.com',
      });
    });

    it('gemini 等不支持的格式抛 BadRequestException', async () => {
      aiChannelsService.resolveChatModel.mockResolvedValueOnce({
        channelId: 'ch-1',
        apiFormat: ApiFormat.GEMINI,
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: API_KEY,
        model: 'gemini-2.5-pro',
      });

      await expect(service.run(buildAgent(), 'thread-1', 'hi')).rejects.toThrow('不支持对话');
    });
  });
});
