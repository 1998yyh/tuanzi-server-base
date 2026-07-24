import { MessageRole, ToolCallRecord } from './entities/message.entity';

/** 本次执行新增的消息数据，用于持久化到 Message 表 */
export interface NewMessageData {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRecord[] | null;
  toolCallId?: string | null;
}

/** SSE 事件：type 为事件名，data 为 JSON 负载 */
export interface SseEvent {
  type: 'message_start' | 'text_delta' | 'tool_use' | 'tool_result' | 'message_end' | 'error';
  data: Record<string, unknown>;
}
