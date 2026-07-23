import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { LlmChatOptions, LlmMessage, LlmResponse } from './llm.types';

/**
 * 基础 LLM 服务层：包装 LangChain ChatModel，对外暴露 chat/chatStream。
 * 不暴露 HTTP 接口、不执行 tool loop，业务逻辑由调用方 Service 负责。
 */
@Injectable()
export class LlmService {
  private readonly defaultModel: ChatAnthropic;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY 未配置，LlmService 无法初始化');
    }
    this.defaultModel = new ChatAnthropic({
      apiKey,
      model: config.get<string>('LLM_DEFAULT_MODEL', 'claude-opus-4-8'),
      maxTokens: Number(config.get('LLM_MAX_TOKENS', '4096')),
    });
  }

  async chat(messages: LlmMessage[], options?: LlmChatOptions): Promise<LlmResponse> {
    const model = this.resolveModel(options);
    const response = await model.invoke(this.toBaseMessages(messages));
    return {
      content: this.extractText(response.content),
      model: (response.response_metadata?.model as string) ?? options?.model ?? 'unknown',
      usage: response.usage_metadata
        ? {
            inputTokens: response.usage_metadata.input_tokens,
            outputTokens: response.usage_metadata.output_tokens,
          }
        : undefined,
    };
  }

  async *chatStream(messages: LlmMessage[], options?: LlmChatOptions): AsyncGenerator<string> {
    const model = this.resolveModel(options);
    const stream = await model.stream(this.toBaseMessages(messages));
    for await (const chunk of stream) {
      const text = this.extractText(chunk.content);
      if (text) yield text;
    }
  }

  /** 根据 per-call options 决定使用默认实例或创建覆盖实例 */
  private resolveModel(options?: LlmChatOptions): ChatAnthropic {
    if (!options?.model && !options?.maxTokens && !options?.tools?.length) {
      return this.defaultModel;
    }
    const overrideModel = new ChatAnthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY')!,
      model: options.model ?? this.config.get<string>('LLM_DEFAULT_MODEL', 'claude-opus-4-8'),
      maxTokens: Number(options.maxTokens ?? this.config.get('LLM_MAX_TOKENS', '4096')),
    });
    if (options.tools?.length) {
      return overrideModel.bindTools(
        options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema, // LangChain 内部转换为 Anthropic SDK snake_case 格式
        })),
      ) as unknown as ChatAnthropic;
    }
    return overrideModel;
  }

  /** LlmMessage[] → LangChain BaseMessage[]；system 消息由 LangChain 自动处理 */
  private toBaseMessages(messages: LlmMessage[]): BaseMessage[] {
    return messages.map((msg) => {
      switch (msg.role) {
        case 'user':
          return new HumanMessage(msg.content);
        case 'assistant':
          return new AIMessage(msg.content);
        case 'system':
          return new SystemMessage(msg.content);
      }
    });
  }

  /**
   * 从 LangChain content 提取纯文本。
   * 当传入 tools 时 LLM 可能返回 ContentBlock[]，只取 type=text 的部分；
   * tool_use block 静默丢弃，本模块不执行 tool loop。
   */
  private extractText(content: string | unknown[]): string {
    if (typeof content === 'string') return content;
    return (content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
}
