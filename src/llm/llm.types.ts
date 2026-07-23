/**
 * LLM 模块对外业务类型。
 * 调用方不直接依赖 LangChain 类型，便于后续切换底层实现。
 */

export interface LlmMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** tool use 透传，inputSchema 为原始 JSON Schema */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmChatOptions {
  model?: string; // 不传则使用 LLM_DEFAULT_MODEL
  maxTokens?: number; // 不传则使用 LLM_MAX_TOKENS
  tools?: LlmTool[]; // 透传给 LangChain bindTools，本模块不执行 tool loop
}

export interface LlmResponse {
  content: string; // 仅含文本内容；tool_use block 静默丢弃
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}
