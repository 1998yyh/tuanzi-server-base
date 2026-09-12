import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { Conversation } from '../agents/entities/conversation.entity';
import type { ResearchContext } from './research-context';
@Entity('stock_research_conversations')
export class ResearchConversation {
  @PrimaryColumn({ name: 'conversation_id', type: 'varchar', length: 36 }) conversationId: string;
  @OneToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;
  @Index()
  @Column({ name: 'user_id', type: 'varchar', length: 36 })
  userId: string;
  @Column({ type: 'json' }) context: ResearchContext;
  @Column({ type: 'json' }) evidence: Record<string, unknown>;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
