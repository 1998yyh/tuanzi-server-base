import { MessageRole, ToolCallRecord } from './entities/message.entity';

/** 本次执行新增的消息数据，用于持久化到 Message 表 */
export interface NewMessageData {
  role: MessageRole;
  content: string;
  /** 推理模型的思考过程（thinking 块全文），非推理模型为 null */
  reasoning?: string | null;
  toolCalls?: ToolCallRecord[] | null;
  toolCallId?: string | null;
  /** 工具执行是否失败（仅 role=tool 有意义；缺省视为成功） */
  isError?: boolean;
  /** 截至本条 assistant 消息的累计 token 消耗（仅 assistant 有值） */
  totalTokens?: number | null;
}

/** SSE 事件：type 为事件名，data 为 JSON 负载。
 *  error 事件的 data 形状为 { code, message }（见 utils/stream-error.ts）。
 *  tool_result 的 data 含 isError?: boolean（工具执行失败/超时标记）。
 *  sub_event 的 data 形状为 { callId, type, data }——delegate_task 子代理的
 *  内部事件（type/data 与顶层同名事件一致），按父工具调用 id 归组。 */
export interface SseEvent {
  type:
    | 'message_start'
    | 'text_delta'
    | 'reasoning_delta'
    | 'tool_use'
    | 'tool_result'
    | 'message_end'
    | 'sub_event'
    | 'error';
  data: Record<string, unknown>;
}
