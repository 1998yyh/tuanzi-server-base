import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * 前端读取的展示层——GET /api/conversations/:id/messages 直接查此表，
 * 无需反序列化 LangGraph 状态
 */
@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ name: 'conversation_id' })
  conversationId: string;

  @Column({ type: 'enum', enum: MessageRole })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'tool_calls', type: 'json', nullable: true })
  toolCalls: ToolCallRecord[] | null;

  /** tool 结果消息关联的 call id */
  @Column({ name: 'tool_call_id', nullable: true })
  toolCallId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
