import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { Annotation, END, START, StateGraph, messagesStateReducer } from '@langchain/langgraph';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { RunnableConfig } from '@langchain/core/runnables';
import { StreamEvent } from '@langchain/core/tracers/log_stream';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { AgentConfig } from './entities/agent-config.entity';
import { MessageRole } from './entities/message.entity';
import { ToolRegistryService } from './tools/tool-registry.service';
import { DelegateToolFactory } from './tools/delegate-tool.factory';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { SkillToolFactory } from '../skills/skill-tool.factory';
import { Skill } from '../skills/skill.entity';
import { TypeORMCheckpointer } from './checkpointers/typeorm.checkpointer';
import { AiChannelsService, ResolvedChatModel } from '../ai-generation/ai-channels.service';
import { ApiFormat } from '../ai-generation/entities/ai-channel.entity';
import { NewMessageData, SseEvent } from './agents.types';

/** 单个工具最长执行时间，超时视为失败让 LLM 决策 */
const TOOL_TIMEOUT_MS = 30_000;

/**
 * 工具调用超时标记错误：文案本身安全（无内部细节），
 * 错误分类时保留原文喂给 LLM（区别于需要脱敏的未知异常）。
 */
class ToolTimeoutError extends Error {}

/** LangGraph 状态：messages 走追加 reducer，其余字段覆盖写 */
const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  iterations: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  maxIterations: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 10,
  }),
});

type AgentState = typeof AgentStateAnnotation.State;

const AGENT_NODE = 'agent_node';
const TOOLS_NODE = 'tools_node';

/**
 * 子代理运行标记（RunnableConfig.metadata key）：metadata 会被子运行继承，
 * delegate_task 子代理图内产生的所有事件都带这个标记——外层 runStream 的
 * streamEvents 会经回调传播收到它们，据此丢弃（子轨迹只走 subHook 旁路的
 * sub_event 通道，否则子代理的 message_end/tool_result 会被当成本轮事件持久化）
 */
const SUB_AGENT_META_KEY = 'subAgentRun';

/** runBatch 批量执行选项 */
export interface BatchRunOptions {
  /** 提供则走 checkpointer 持久化（thread_id = 该值）；缺省为一次性无历史执行 */
  threadId?: string;
  /** Skill 子 Agent 的执行指令（替代 agentConfig.systemPrompt） */
  overrideSystemPrompt?: string | null;
  /** Skill 子 Agent 的工具集（替代正常工具加载） */
  overrideTools?: StructuredToolInterface[];
  /** 防递归：为 true 时不注入 Skill 工具（Task 4 生效） */
  isSkillExecution?: boolean;
  /** 中止信号（如后台任务超时）：透传给 LangGraph 执行 */
  signal?: AbortSignal;
}

/** runStream 流式执行选项 */
export interface RunStreamOptions {
  /** 中止信号（如 SSE 客户端断线）：透传给 LangGraph 执行，中止当前 run */
  signal?: AbortSignal;
}

/**
 * Agent 执行核心：LangGraph 状态图（ReAct loop）构建与执行。
 *
 * 图结构：
 *   START → agent_node → [有 tool_calls 且未超 maxIterations？]
 *                           ↓ 是            ↓ 否
 *                       tools_node          END
 *                           ↓
 *                       回到 agent_node
 *
 * 会话状态由 TypeORMCheckpointer 持久化（thread_id = conversationId）。
 */
@Injectable()
export class AgentExecutorService {
  private readonly logger = new Logger(AgentExecutorService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly checkpointer: TypeORMCheckpointer,
    private readonly mcpServersService: McpServersService,
    private readonly skillToolFactory: SkillToolFactory,
    private readonly delegateToolFactory: DelegateToolFactory,
    private readonly aiChannelsService: AiChannelsService,
  ) {}

  /**
   * 同步执行：等待整个 tool loop 结束，返回本轮新增的消息（不含用户消息本身）。
   */
  async run(
    agentConfig: AgentConfig,
    conversationId: string,
    userMessage: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<NewMessageData[]> {
    const tools = await this.getAllTools(agentConfig);
    const graph = await this.buildGraph(agentConfig, tools);
    const config: RunnableConfig = {
      configurable: { thread_id: conversationId },
      signal: options.signal,
    };

    // 记录调用前的消息数：invoke 返回的 messages 含完整历史（Checkpointer 恢复的
    // 旧消息 + 本次新消息），直接全量持久化会把历史重复写进 Message 表
    const stateBefore = await graph.getState(config);
    const previousCount = (stateBefore?.values?.messages?.length ?? 0) as number;

    const result = await graph.invoke(
      {
        messages: [new HumanMessage(userMessage)],
        // iterations 必须随每轮重置：checkpoint 恢复会带上历史累计值，
        // 不重置会让会话在累计 N 轮后永久跳过 tools_node（工具调用得不到执行）
        iterations: 0,
        maxIterations: agentConfig.maxIterations,
      },
      config,
    );

    // 只取本轮新增部分（+1 跳过 userMessage 本身，它已由 ConversationsService 单独持久化）
    const newMessages = (result.messages as BaseMessage[]).slice(previousCount + 1);
    // token 用量跨条累计，与流式路径语义一致（最后一条 assistant = 本轮总消耗）
    let runningTotal = 0;
    return newMessages.map((m) => {
      const data = this.toMessageData(m);
      if (data.totalTokens != null) {
        runningTotal += data.totalTokens;
        data.totalTokens = runningTotal;
      }
      return data;
    });
  }

  /**
   * 流式执行：透传 streamEvents v2 事件为 SSE 事件。
   * 事件流由 ConversationsService 消费并负责最终的消息持久化。
   * options.signal 用于客户端断线时中止底层执行（LangGraph RunnableConfig.signal）。
   *
   * 合并队列：外层 graph 事件由 pump 异步消费推入队列；delegate_task 子代理的
   * 内部事件经 subHook 同步推入（包装为 sub_event）。子事件天然落在父 tool_use
   * 与 tool_result 之间——工具 promise settle 前 on_tool_end 不会触发。
   */
  async *runStream(
    agentConfig: AgentConfig,
    conversationId: string,
    userMessage: string,
    options: RunStreamOptions = {},
  ): AsyncGenerator<SseEvent> {
    // 本轮执行中失败的工具调用 id 集合：tools_node 的 catch 分支写入，
    // mapToSseEvent 的 on_tool_end 据此给 tool_result 事件标 isError
    const erroredToolCalls = new Set<string>();

    const queue: (SseEvent | null)[] = []; // null = 外层流结束哨兵
    let wakeup: (() => void) | null = null;
    const push = (e: SseEvent | null) => {
      queue.push(e);
      wakeup?.();
      wakeup = null;
    };
    const subHook = (callId: string, e: SseEvent) =>
      push({ type: 'sub_event', data: { callId, type: e.type, data: e.data } });

    const tools = await this.getAllTools(agentConfig, false, subHook);
    const graph = await this.buildGraph(agentConfig, tools, true, erroredToolCalls);

    let totalTokens = 0;
    const pump = (async () => {
      try {
        const stream = graph.streamEvents(
          {
            messages: [new HumanMessage(userMessage)],
            // iterations 必须随每轮重置：checkpoint 恢复会带上历史累计值，
            // 不重置会让会话在累计 N 轮后永久跳过 tools_node（工具调用得不到执行）
            iterations: 0,
            maxIterations: agentConfig.maxIterations,
          },
          {
            configurable: { thread_id: conversationId },
            version: 'v2' as const,
            signal: options.signal,
          },
        );
        for await (const event of stream) {
          // 子代理（delegate_task）图内事件经回调传播冒泡到外层：一律丢弃，
          // 子轨迹由 subHook 的 sub_event 通道承载（见 SUB_AGENT_META_KEY 注释）
          const meta = event.metadata as Record<string, unknown> | undefined;
          if (meta?.[SUB_AGENT_META_KEY]) continue;
          const sseEvent = this.mapToSseEvent(event, erroredToolCalls);
          if (!sseEvent) continue;
          if (sseEvent.type === 'message_end') {
            // message_end 携带本轮 assistant 完整内容（含 toolCalls），
            // 供 ConversationsService 在流结束后持久化；token 为跨轮累计值
            totalTokens += (sseEvent.data.totalTokens as number) ?? 0;
            sseEvent.data = {
              ...sseEvent.data,
              conversationId,
              totalTokens,
            };
          }
          push(sseEvent);
        }
      } finally {
        push(null); // 无论成败都发哨兵，保证主循环退出（异常经 await pump 传播）
      }
    })();

    for (;;) {
      if (!queue.length) {
        await new Promise<void>((resolve) => (wakeup = resolve));
        continue;
      }
      const sseEvent = queue.shift()!;
      if (sseEvent === null) break;
      yield sseEvent;
    }
    await pump; // 传播 pump 内异常（模型错误等）
  }

  /**
   * delegate_task 子代理执行：无 checkpoint 的一次性运行（复用父 Agent 的模型/渠道），
   * 内部 streamEvents 映射后经 onEvent 回调实时透出（外层包装为 sub_event）。
   * 返回子代理最终 assistant 文本作为工具结果。
   */
  async runSubAgent(
    config: AgentConfig,
    input: string,
    options: { onEvent: (e: SseEvent) => void; signal?: AbortSignal },
  ): Promise<string> {
    const erroredToolCalls = new Set<string>();
    // 子代理工具集：内置 + MCP。isSkillExecution=true → 不注入 Skill 工具，
    // 也不注入 delegate_task（getAllTools 无 subHook 分支），递归深度锁死为 1
    const subTools = await this.getAllTools(config, true);
    const graph = await this.buildGraph(config, subTools, false, erroredToolCalls);

    const stream = graph.streamEvents(
      {
        messages: [new HumanMessage(input)],
        // iterations 必须随每轮重置：checkpoint 恢复会带上历史累计值，
        // 不重置会让会话在累计 N 轮后永久跳过 tools_node（工具调用得不到执行）
        iterations: 0,
        maxIterations: config.maxIterations,
      },
      {
        version: 'v2' as const,
        signal: options.signal,
        // 标记子代理运行：事件冒泡到外层 streamEvents 时据此被丢弃（防持久化污染）
        metadata: { [SUB_AGENT_META_KEY]: true },
      },
    );

    let finalText = '';
    for await (const event of stream) {
      const sseEvent = this.mapToSseEvent(event, erroredToolCalls);
      if (!sseEvent) continue;
      if (sseEvent.type === 'message_end') {
        const content = sseEvent.data.content as string;
        if (content) finalText = content; // 最后一轮非空内容即最终回答
      }
      options.onEvent(sseEvent);
    }
    return finalText || '（子代理未产生输出）';
  }

  /**
   * 批量执行：不走 SSE，await 完整结果后返回本轮新增消息。
   *
   * 两种形态：
   * - 带 threadId 且无覆盖项：等价 run（走 checkpoint，第三期定时任务用）
   * - 其余：一次性无历史执行（Skill 子 Agent 用），不产生 checkpoint 数据
   */
  async runBatch(
    agentConfig: AgentConfig,
    userMessage: string,
    options: BatchRunOptions = {},
  ): Promise<NewMessageData[]> {
    const hasOverrides =
      options.overrideTools !== undefined ||
      options.overrideSystemPrompt !== undefined ||
      options.isSkillExecution === true;
    if (options.threadId && !hasOverrides) {
      return this.run(agentConfig, options.threadId, userMessage, { signal: options.signal });
    }

    const tools =
      options.overrideTools ??
      (await this.getAllTools(agentConfig, options.isSkillExecution ?? false));
    const graph = await this.buildGraph(
      { ...agentConfig, systemPrompt: options.overrideSystemPrompt ?? agentConfig.systemPrompt },
      tools,
      false,
    );
    const invokeConfig: RunnableConfig = options.threadId
      ? { configurable: { thread_id: options.threadId }, signal: options.signal }
      : { signal: options.signal };

    const result = await graph.invoke(
      {
        messages: [new HumanMessage(userMessage)],
        // iterations 必须随每轮重置：checkpoint 恢复会带上历史累计值，
        // 不重置会让会话在累计 N 轮后永久跳过 tools_node（工具调用得不到执行）
        iterations: 0,
        maxIterations: agentConfig.maxIterations,
      },
      invokeConfig,
    );

    // 一次性执行无历史：跳过 userMessage 本身即全部新增消息
    const newMessages = (result.messages as BaseMessage[]).slice(1);
    let runningTotal = 0;
    return newMessages.map((m) => {
      const data = this.toMessageData(m);
      if (data.totalTokens != null) {
        runningTotal += data.totalTokens;
        data.totalTokens = runningTotal;
      }
      return data;
    });
  }

  /**
   * 汇总三层工具：内置工具 + MCP 工具 + Skill 工具。
   * isSkillExecution=true 时为 Skill 子 Agent 执行，跳过 Skill 注入（防递归）。
   * subHook 仅流式路径（runStream）提供：delegate_task 按运行注入（registry 查不到
   * 这个 executor 专属工具），子代理事件经 subHook 包装为 sub_event 透出；
   * 批量路径无 subHook → 不注入（子代理在无透出能力的环境里会静默长跑）。
   */
  private async getAllTools(
    config: AgentConfig,
    isSkillExecution = false,
    subHook?: (callId: string, e: SseEvent) => void,
  ): Promise<StructuredToolInterface[]> {
    const mcpServers = await this.mcpServersService.findByAgentConfig(config.id);
    const tools = await this.toolRegistry.getToolsForAgent(config, mcpServers);
    if (isSkillExecution) {
      return tools;
    }
    if (subHook && config.enabledTools?.includes('delegate_task')) {
      tools.push(
        this.delegateToolFactory.createTool({
          runSubAgent: (task, callId, signal) =>
            this.runSubAgent(config, task, {
              signal,
              onEvent: (e) => subHook(callId, e),
            }),
        }),
      );
    }
    const skillTools = await this.skillToolFactory.createToolsForAgent(config, {
      runBatch: (userMessage, options) => this.runBatch(config, userMessage, options),
      buildSubTools: (skill) => this.buildSkillSubTools(config, skill),
    });
    // Skill 名与内置/MCP 工具同名时跳过：bindTools 收到重名工具会让模型 API 直接报错
    const existingNames = new Set(tools.map((t) => t.name));
    const dedupedSkillTools = skillTools.filter((t) => {
      if (existingNames.has(t.name)) {
        this.logger.warn(`Skill 工具 "${t.name}" 与内置/MCP 工具同名，已跳过`);
        return false;
      }
      return true;
    });
    return [...tools, ...dedupedSkillTools];
  }

  /** Skill 子 Agent 的工具集：Skill.enabledTools（内置）+ Skill.mcpServers（MCP，过滤停用并解密） */
  private async buildSkillSubTools(
    config: AgentConfig,
    skill: Skill,
  ): Promise<StructuredToolInterface[]> {
    const mcpRuntime = (skill.mcpServers ?? [])
      .filter((s) => s.isActive)
      .map((s) => this.mcpServersService.toRuntimeConfig(s));
    return this.toolRegistry.getToolsForAgent(
      { ...config, enabledTools: skill.enabledTools ?? [] },
      mcpRuntime,
    );
  }

  private async buildGraph(
    config: AgentConfig,
    tools: StructuredToolInterface[],
    useCheckpointer = true,
    erroredToolCalls: Set<string> = new Set(),
  ) {
    const model = await this.createModelFromConfig(config);
    if (tools.length && !model.bindTools) {
      throw new BadRequestException(`模型 ${config.modelName} 不支持工具调用，请关闭工具配置`);
    }
    const modelWithTools = tools.length ? model.bindTools!(tools) : model;
    // 系统级时间戳元数据（Kimi 风格）：graph 每次调用都重建，时间戳随每轮用户消息刷新；
    // 与用户 systemPrompt 拼接后前插到模型输入，不写入 checkpoint
    const timeMeta = `timestamp="${this.formatTimestamp()}"`;
    const systemMessage = new SystemMessage(
      config.systemPrompt ? `${config.systemPrompt}\n\n${timeMeta}` : timeMeta,
    );

    const graph = new StateGraph(AgentStateAnnotation)
      .addNode(AGENT_NODE, async (state: AgentState) => {
        // systemMessage 只在调用时前插，不写入图状态（避免 checkpoint 里重复存）
        const input = [systemMessage, ...state.messages];
        const response = await modelWithTools.invoke(input);
        return { messages: [response], iterations: state.iterations + 1 };
      })
      .addNode(TOOLS_NODE, async (state: AgentState, config?: RunnableConfig) => {
        const lastMsg = state.messages.at(-1) as AIMessage;
        // 透传 thread_id 给工具：agent-scoped 工具（如 run_background_task）
        // 需要从 config.configurable.thread_id 读取来源会话
        const threadId = config?.configurable?.thread_id as string | undefined;
        const results = await Promise.all(
          (lastMsg.tool_calls ?? []).map(async (call) => {
            const tool = tools.find((t) => t.name === call.name);
            let isError = false;
            let output: unknown;
            if (tool) {
              output = await this.invokeToolWithTimeout(tool, call.args, call.id, threadId).catch(
                (e: unknown) => {
                  isError = true;
                  return this.formatToolError(e);
                },
              );
            } else {
              isError = true;
              output = `未找到工具: ${call.name}`;
            }
            if (isError && call.id) erroredToolCalls.add(call.id);
            return new ToolMessage({
              content: typeof output === 'string' ? output : JSON.stringify(output),
              tool_call_id: call.id ?? '',
              name: call.name,
              // 批量路径（runBatch）的持久化从这里读 isError；流式路径走 erroredToolCalls
              additional_kwargs: isError ? { isError: true } : {},
            });
          }),
        );
        return { messages: results };
      })
      .addEdge(START, AGENT_NODE)
      .addConditionalEdges(AGENT_NODE, (state: AgentState) => {
        const last = state.messages.at(-1) as AIMessage;
        if (last.tool_calls?.length && state.iterations < state.maxIterations) {
          return TOOLS_NODE;
        }
        return END;
      })
      .addEdge(TOOLS_NODE, AGENT_NODE);

    return graph.compile(useCheckpointer ? { checkpointer: this.checkpointer } : {});
  }

  /**
   * 带超时的工具调用；无论成败都清理定时器，避免悬挂 30s 的 timer。
   * toolCallId 经 RunnableConfig.metadata 透传，使 streamEvents 的
   * on_tool_start/on_tool_end 事件能以模型的 tool_call id（而非运行时 run_id）
   * 标识调用——前端流式配对与消息历史归组（toolCallId ↔ toolCalls[].id）都依赖它。
   *
   * 超时中止：LangChain RunnableConfig.signal 会把 abort 透传给工具执行
   * （DynamicStructuredTool 的 func 收到 config 第三参；MCP 适配工具转发给
   * MCP SDK 的 request signal），尽量取消底层副作用，避免超时后工具仍在后台跑。
   *
   * 单工具可通过在实例上挂 timeoutMs 覆盖默认 30s（delegate_task 子代理执行
   * 需要分钟级时长）；threadId 透传给 agent-scoped 工具读取来源会话。
   */
  private invokeToolWithTimeout(
    tool: StructuredToolInterface,
    args: unknown,
    toolCallId?: string,
    threadId?: string,
  ): Promise<unknown> {
    const timeoutMs = (tool as { timeoutMs?: number }).timeoutMs ?? TOOL_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      Promise.resolve(
        tool.invoke(args, {
          metadata: { tool_call_id: toolCallId ?? '' },
          configurable: threadId ? { thread_id: threadId } : undefined,
          signal: controller.signal,
        }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ToolTimeoutError(`工具调用超时（${timeoutMs / 1000}s）`));
        }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * 工具执行错误 → 回喂 LLM 的 ToolMessage 文案。
   *
   * 脱敏原则（与 utils/stream-error.ts 的 classifyStreamError 一致）：
   * - HttpException（业务错误，中文消息）：保留原文，LLM 能据此决策（如重试/换工具）
   * - ToolTimeoutError：超时文案本身无内部细节，保留
   * - 其他未知异常（MCP URL、命令、DB 错误等内部细节）：只记服务端日志，
   *   回喂通用文案，防止内部细节持久化进 messages 表并随 SSE 透出
   */
  private formatToolError(e: unknown): string {
    if (e instanceof HttpException) {
      const response = e.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : (response as { message?: unknown } | null)?.message;
      return typeof message === 'string' && message ? message : '工具执行失败，请稍后重试';
    }
    if (e instanceof ToolTimeoutError) {
      return e.message;
    }
    this.logger.error(
      `工具执行异常: ${e instanceof Error ? e.message : String(e)}`,
      e instanceof Error ? e.stack : undefined,
    );
    return '工具执行失败，请稍后重试';
  }

  /**
   * 当前时间（北京时间），格式 `2026-08-02 20:00:00 +08:00`。
   * sv-SE locale 输出即 ISO 风格的 YYYY-MM-DD HH:mm:ss。
   */
  private formatTimestamp(): string {
    const datetime = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date());
    return `${datetime} +08:00`;
  }

  /** 按 Agent 引用的渠道创建 ChatModel；解密结果只活在函数栈帧 */
  private async createModelFromConfig(config: AgentConfig): Promise<BaseChatModel> {
    const resolved: ResolvedChatModel = await this.aiChannelsService.resolveChatModel(
      config.userId,
      config.channelId,
      config.modelName,
    );
    switch (resolved.apiFormat) {
      case ApiFormat.ANTHROPIC:
        return new ChatAnthropic({
          apiKey: resolved.apiKey,
          model: resolved.model,
          maxTokens: config.maxTokens,
          anthropicApiUrl: resolved.baseUrl,
        });
      case ApiFormat.OPENAI:
        return new ChatOpenAI({
          apiKey: resolved.apiKey,
          model: resolved.model,
          maxTokens: config.maxTokens,
          configuration: { baseURL: resolved.baseUrl },
        });
      default:
        throw new BadRequestException(`渠道格式 "${resolved.apiFormat}" 不支持对话`);
    }
  }

  /** LangChain BaseMessage → Message 表持久化数据 */
  private toMessageData(message: BaseMessage): NewMessageData {
    if (ToolMessage.isInstance(message)) {
      return {
        role: MessageRole.TOOL,
        content:
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        toolCallId: message.tool_call_id,
        // tools_node 在失败时打上的标记（流式路径走 erroredToolCalls 集合，这里供批量路径）
        isError: message.additional_kwargs?.isError === true ? true : undefined,
      };
    }
    if (AIMessage.isInstance(message)) {
      const toolCalls = message.tool_calls?.map((tc) => ({
        id: tc.id ?? '',
        name: tc.name,
        args: tc.args as Record<string, unknown>,
      }));
      const usage = message.usage_metadata;
      const reasoning = this.extractThinking(message.content);
      return {
        role: MessageRole.ASSISTANT,
        content: this.extractText(message.content),
        reasoning: reasoning || null,
        toolCalls: toolCalls?.length ? toolCalls : null,
        totalTokens: usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null,
      };
    }
    // HumanMessage 等不持久化（用户消息由 ConversationsService 单独写）
    return {
      role: MessageRole.ASSISTANT,
      content: this.extractText(message.content),
    };
  }

  /**
   * streamEvents v2 → SSE 事件映射。
   * 只关注 agent_node 的模型事件与工具事件，其余（chain/graph 级）忽略。
   */
  private mapToSseEvent(event: StreamEvent, erroredToolCalls?: Set<string>): SseEvent | null {
    const node = (event.metadata as Record<string, unknown> | undefined)?.langgraph_node;

    switch (event.event) {
      case 'on_chat_model_start':
        if (node !== AGENT_NODE) return null;
        return { type: 'message_start', data: { role: 'assistant' } };

      case 'on_chat_model_stream': {
        if (node !== AGENT_NODE) return null;
        const chunk = event.data?.chunk as AIMessageChunk | undefined;
        const text = chunk ? this.extractText(chunk.content) : '';
        if (text) return { type: 'text_delta', data: { text } };
        // 推理模型的 thinking 块同样流式到达：透传给前端展示「思考过程」，
        // 否则思考阶段（常占数秒）前端零事件，体感像卡死
        const reasoning = chunk ? this.extractThinking(chunk.content) : '';
        return reasoning ? { type: 'reasoning_delta', data: { text: reasoning } } : null;
      }

      case 'on_chat_model_end': {
        if (node !== AGENT_NODE) return null;
        const output = event.data?.output as AIMessage | undefined;
        const totalTokens =
          (output?.usage_metadata?.input_tokens ?? 0) +
          (output?.usage_metadata?.output_tokens ?? 0);
        // 以最终 AIMessage 为准重建内容与 toolCalls（比逐事件拼接更稳），
        // text_delta / reasoning_delta / tool_use 事件仅用于前端实时展示
        const toolCalls = output?.tool_calls?.map((tc) => ({
          id: tc.id ?? '',
          name: tc.name,
          args: tc.args as Record<string, unknown>,
        }));
        const reasoning = output ? this.extractThinking(output.content) : '';
        return {
          type: 'message_end',
          data: {
            content: output ? this.extractText(output.content) : '',
            reasoning: reasoning || null,
            toolCalls: toolCalls?.length ? toolCalls : null,
            totalTokens,
          },
        };
      }

      case 'on_tool_start':
        return {
          type: 'tool_use',
          data: {
            // 优先用模型的 tool_call id（invoke 时经 metadata 透传），回退 run_id
            id: ((event.metadata as Record<string, unknown> | undefined)?.tool_call_id ||
              event.run_id) as string,
            name: event.name,
            args: (event.data?.input as Record<string, unknown>) ?? {},
          },
        };

      case 'on_tool_end': {
        const output = event.data?.output;
        const content =
          typeof output === 'object' && output !== null && 'content' in output
            ? String((output as ToolMessage).content)
            : String(output ?? '');
        const callId = ((event.metadata as Record<string, unknown> | undefined)?.tool_call_id ||
          event.run_id) as string;
        return {
          type: 'tool_result',
          data: {
            callId,
            name: event.name,
            content,
            // tools_node 的 catch 分支会把失败的 callId 记入集合（on_tool_end 的
            // output 是 tool.invoke 的原始返回，读不到 ToolMessage 的附加标记）
            isError: erroredToolCalls?.has(callId) === true,
          },
        };
      }

      default:
        return null;
    }
  }

  /** 从 LangChain content 提取纯文本（兼容 string 与 ContentBlock[] 两种形态） */
  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return (content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }

  /** 从 LangChain content 提取推理模型的 thinking 块文本（非推理模型/非流式块返回 ''） */
  private extractThinking(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return (content as Array<{ type: string; thinking?: string }>)
      .filter((b) => b.type === 'thinking')
      .map((b) => b.thinking ?? '')
      .join('');
  }
}
