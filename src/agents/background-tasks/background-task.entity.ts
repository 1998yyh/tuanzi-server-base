import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Conversation } from '../entities/conversation.entity';

export enum BackgroundTaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
}

/**
 * 后台任务：Agent 通过 run_background_task 工具把耗时工作丢到后台异步执行，
 * 完成后结果以普通 assistant 消息写回来源会话（前端轮询本表驱动头部 pill）。
 *
 * ⚠️ synchronize=false：本实体上线前需手动执行 DDL（见 docs 或部署记录）。
 */
@Entity('background_tasks')
@Index(['conversationId', 'status'])
export class BackgroundTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  /** 来源会话：任务完成后结果消息写回这里 */
  @Column({ name: 'conversation_id' })
  conversationId: string;

  @Column({ name: 'agent_config_id' })
  agentConfigId: string;

  @Column({ type: 'enum', enum: BackgroundTaskStatus, default: BackgroundTaskStatus.PENDING })
  status: BackgroundTaskStatus;

  /** 交给后台 Agent 执行的任务描述（主 Agent 现场编写，需自包含） */
  @Column({ type: 'text' })
  input: string;

  /** 完成后写回会话的最后一条 assistant 消息 id（便于前端定位/跳转） */
  @Column({ name: 'result_message_id', type: 'varchar', length: 36, nullable: true })
  resultMessageId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'finished_at', type: 'datetime', nullable: true })
  finishedAt: Date | null;
}
