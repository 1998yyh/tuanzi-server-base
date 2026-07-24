import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { AgentConfig } from './agent-config.entity';
import { Message } from './message.entity';

export enum ConversationStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@Entity('conversations')
export class Conversation {
  /** 同时作为 LangGraph 的 thread_id */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => AgentConfig, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_config_id' })
  agentConfig: AgentConfig;

  @Column({ name: 'agent_config_id' })
  agentConfigId: string;

  /** 默认取首条用户消息前 30 字 */
  @Column({ length: 255, nullable: true })
  title: string | null;

  @Column({
    type: 'enum',
    enum: ConversationStatus,
    default: ConversationStatus.ACTIVE,
  })
  status: ConversationStatus;

  @OneToMany(() => Message, (m) => m.conversation)
  messages: Message[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
