import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Generated,
  Index,
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
@Index(['conversationId', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 自增排序键：同一轮消息批量 INSERT 时 created_at（datetime(6)）完全相同，
   * uuid 主键又无序，DESC 分页需要 seq 做同刻 tie-break（页内顺序 = 插入顺序）。
   * bigint 在 TypeORM 中映射为 string，仅作排序，不参与业务。
   */
  @Index({ unique: true })
  @Column({ type: 'bigint' })
  @Generated('increment')
  seq: string;

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
  @Column({ name: 'tool_call_id', type: 'varchar', length: 255, nullable: true })
  toolCallId: string | null;

  /**
   * 累计 token 消耗（input+output），仅 assistant 消息有值，其余为 NULL。
   * 同步路径：每条 assistant 记截至本条的轮内累计值；
   * 流式路径：跨轮累计值只写在本轮最终的 assistant 消息上。
   */
  @Column({ name: 'total_tokens', type: 'int', nullable: true })
  totalTokens: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
