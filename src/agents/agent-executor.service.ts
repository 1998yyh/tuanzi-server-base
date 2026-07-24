import { BadRequestException, Inject, Injectable } from '@nestjs/common';
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
import { StreamEvent } from '@langchain/core/tracers/log_stream';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { AgentConfig, ProviderType } from './entities/agent-config.entity';
import { MessageRole } from './entities/message.entity';
import { ToolRegistryService } from './tools/tool-registry.service';
import { TypeORMCheckpointer } from './checkpointers/typeorm.checkpointer';
import { AGENT_ENCRYPTION_KEY } from './utils/encryption-key.provider';
import { decrypt } from './utils/crypto.util';
import { NewMessageData, SseEvent } from './agents.types';

/** 单个工具最长执行时间，超时视为失败让 LLM 决策 */
const TOOL_TIMEOUT_MS = 30_000;

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
  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly checkpointer: TypeORMCheckpointer,
    @Inject(AGENT_ENCRYPTION_KEY)
    private readonly encryptionKey: string,
  ) {}

  /**
   * 同步执行：等待整个 tool loop 结束，返回本轮新增的消息（不含用户消息本身）。
   */
  async run(
    agentConfig: AgentConfig,
    conversationId: string,
    userMessage: string,
  ): Promise<NewMessageData[]> {
    const tools = await this.toolRegistry.getToolsForAgent(agentConfig);
    const graph = this.buildGraph(agentConfig, tools);
    const config = { configurable: { thread_id: conversationId } };

    // 记录调用前的消息数：invoke 返回的 messages 含完整历史（Checkpointer 恢复的
    // 旧消息 + 本次新消息），直接全量持久化会把历史重复写进 Message 表
    const stateBefore = await graph.getState(config);
    const previousCount = (stateBefore?.values?.messages?.length ?? 0) as number;

    const result = await graph.invoke(
      {
        messages: [new HumanMessage(userMessage)],
        maxIterations: agentConfig.maxIterations,
      },
      config,
    );

    // 只取本轮新增部分（+1 跳过 userMessage 本身，它已由 ConversationsService 单独持久化）
    const newMessages = (result.messages as BaseMessage[]).slice(previousCount + 1);
    return newMessages.map((m) => this.toMessageData(m));
  }

  /**
   * 流式执行：透传 streamEvents v2 事件为 SSE 事件。
   * 事件流由 ConversationsService 消费并负责最终的消息持久化。
   */
  async *runStream(
    agentConfig: AgentConfig,
    conversationId: string,
    userMessage: string,
  ): AsyncGenerator<SseEvent> {
    const tools = await this.toolRegistry.getToolsForAgent(agentConfig);
    const graph = this.buildGraph(agentConfig, tools);

    const stream = graph.streamEvents(
      {
        messages: [new HumanMessage(userMessage)],
        maxIterations: agentConfig.maxIterations,
      },
      {
        configurable: { thread_id: conversationId },
        version: 'v2' as const,
      },
    );

    let totalTokens = 0;
    for await (const event of stream) {
      const sseEvent = this.mapToSseEvent(event);
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
      yield sseEvent;
    }
  }

  private buildGraph(config: AgentConfig, tools: StructuredToolInterface[]) {
    const model = this.createModelFromConfig(config);
    if (tools.length && !model.bindTools) {
      throw new BadRequestException(`模型 ${config.model} 不支持工具调用，请关闭工具配置`);
    }
    const modelWithTools = tools.length ? model.bindTools!(tools) : model;
    const systemMessage = config.systemPrompt ? new SystemMessage(config.systemPrompt) : null;

    const graph = new StateGraph(AgentStateAnnotation)
      .addNode(AGENT_NODE, async (state: AgentState) => {
        // systemPrompt 只在调用时前插，不写入图状态（避免 checkpoint 里重复存）
        const input = systemMessage ? [systemMessage, ...state.messages] : state.messages;
        const response = await modelWithTools.invoke(input);
        return { messages: [response], iterations: state.iterations + 1 };
      })
      .addNode(TOOLS_NODE, async (state: AgentState) => {
        const lastMsg = state.messages.at(-1) as AIMessage;
        const results = await Promise.all(
          (lastMsg.tool_calls ?? []).map(async (call) => {
            const tool = tools.find((t) => t.name === call.name);
            const output = tool
              ? await this.invokeToolWithTimeout(tool, call.args).catch(
                  (e: Error) => `工具调用失败: ${e.message}`,
                )
              : `未找到工具: ${call.name}`;
            return new ToolMessage({
              content: typeof output === 'string' ? output : JSON.stringify(output),
              tool_call_id: call.id ?? '',
              name: call.name,
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

    return graph.compile({ checkpointer: this.checkpointer });
  }

  /** 带超时的工具调用；无论成败都清理定时器，避免悬挂 30s 的 timer */
  private invokeToolWithTimeout(tool: StructuredToolInterface, args: unknown): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      Promise.resolve(tool.invoke(args)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`工具调用超时（${TOOL_TIMEOUT_MS / 1000}s）`)),
          TOOL_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** 按 Agent 配置创建 ChatModel；解密结果只活在函数栈帧 */
  private createModelFromConfig(config: AgentConfig): BaseChatModel {
    const apiKey = decrypt(config.apiKeyEncrypted, this.encryptionKey);
    switch (config.provider) {
      case ProviderType.ANTHROPIC:
        return new ChatAnthropic({
          apiKey,
          model: config.model,
          maxTokens: config.maxTokens,
        });
      case ProviderType.OPENAI:
        return new ChatOpenAI({
          apiKey,
          model: config.model,
          maxTokens: config.maxTokens,
        });
      default:
        throw new BadRequestException(`暂不支持的 provider: ${config.provider}`);
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
      };
    }
    if (AIMessage.isInstance(message)) {
      const toolCalls = message.tool_calls?.map((tc) => ({
        id: tc.id ?? '',
        name: tc.name,
        args: tc.args as Record<string, unknown>,
      }));
      return {
        role: MessageRole.ASSISTANT,
        content: this.extractText(message.content),
        toolCalls: toolCalls?.length ? toolCalls : null,
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
  private mapToSseEvent(event: StreamEvent): SseEvent | null {
    const node = (event.metadata as Record<string, unknown> | undefined)?.langgraph_node;

    switch (event.event) {
      case 'on_chat_model_start':
        if (node !== AGENT_NODE) return null;
        return { type: 'message_start', data: { role: 'assistant' } };

      case 'on_chat_model_stream': {
        if (node !== AGENT_NODE) return null;
        const chunk = event.data?.chunk as AIMessageChunk | undefined;
        const text = chunk ? this.extractText(chunk.content) : '';
        return text ? { type: 'text_delta', data: { text } } : null;
      }

      case 'on_chat_model_end': {
        if (node !== AGENT_NODE) return null;
        const output = event.data?.output as AIMessage | undefined;
        const totalTokens =
          (output?.usage_metadata?.input_tokens ?? 0) +
          (output?.usage_metadata?.output_tokens ?? 0);
        // 以最终 AIMessage 为准重建内容与 toolCalls（比逐事件拼接更稳），
        // text_delta / tool_use 事件仅用于前端实时展示
        const toolCalls = output?.tool_calls?.map((tc) => ({
          id: tc.id ?? '',
          name: tc.name,
          args: tc.args as Record<string, unknown>,
        }));
        return {
          type: 'message_end',
          data: {
            content: output ? this.extractText(output.content) : '',
            toolCalls: toolCalls?.length ? toolCalls : null,
            totalTokens,
          },
        };
      }

      case 'on_tool_start':
        return {
          type: 'tool_use',
          data: {
            id: event.run_id,
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
        return {
          type: 'tool_result',
          data: { callId: event.run_id, name: event.name, content },
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
}
