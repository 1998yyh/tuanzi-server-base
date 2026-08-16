import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/users.entity';
import { AiChannel, ModelCapability } from './ai-channel.entity';
import { MediaFile } from '../../media/media-file.entity';

/** 生成任务状态：pending/processing 为进行中（视频轮询），其余为终态 */
export enum GenerationTaskStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/** 生成结果回填画布节点的引用 */
export interface GenerationNodeRef {
  projectId: string;
  nodeId: string;
}

/**
 * 生成任务：图片/音频为同步完成的历史记录；视频为异步主体，
 * 由 generation-poller 轮询渠道侧任务直至终态。
 */
@Entity('generation_tasks')
@Index(['userId', 'status'])
@Index(['status', 'createdAt'])
export class GenerationTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => AiChannel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: AiChannel;

  @Column({ name: 'channel_id' })
  channelId: string;

  @Column({ length: 100 })
  model: string;

  @Column({ type: 'enum', enum: ModelCapability })
  capability: ModelCapability;

  @Column({ type: 'enum', enum: GenerationTaskStatus, default: GenerationTaskStatus.PENDING })
  status: GenerationTaskStatus;

  @Column({ type: 'text' })
  prompt: string;

  /** 请求参数快照（size/quality/seconds/voice 等） */
  @Column({ type: 'json', nullable: true })
  params: Record<string, unknown> | null;

  /** 渠道侧任务 ID（视频等异步任务） */
  @Column({ name: 'remote_task_id', type: 'varchar', length: 200, nullable: true })
  remoteTaskId: string | null;

  @ManyToOne(() => MediaFile, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'result_media_id' })
  resultMedia: MediaFile | null;

  @Column({ name: 'result_media_id', type: 'varchar', length: 36, nullable: true })
  resultMediaId: string | null;

  /** 额外结果（多图时为 media id 数组等） */
  @Column({ name: 'result_extra', type: 'json', nullable: true })
  resultExtra: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  /** 关联的画布节点（生成完成后回填） */
  @Column({ name: 'node_ref', type: 'json', nullable: true })
  nodeRef: GenerationNodeRef | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
