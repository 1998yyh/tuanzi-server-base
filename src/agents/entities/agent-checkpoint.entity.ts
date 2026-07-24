import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * LangGraph 图状态快照。由 TypeORMCheckpointer 独占读写，业务代码不直接操作。
 *
 * ⚠️ 追加写入模式：每个图节点执行完插入一行，是全库增长最快的表。
 * 清理策略：会话删除时按 thread_id 手动清理（不与 Conversation 建外键）。
 *
 * 主键用自增 id 而非 uuid：checkpoint_id 是 LangGraph 内部生成的字符串，
 * 「取最新快照」需要可靠的插入顺序排序键。
 * checkpoint/checkpoint_metadata 存 base64 编码的序列化字节（serde.dumpsTyped 产物），
 * 用 MEDIUMTEXT（16MB）——多轮 tool loop 后状态轻松超出 TEXT 的 65KB 上限。
 */
@Entity('agent_checkpoints')
@Index(['threadId', 'checkpointNs', 'checkpointId'], { unique: true })
export class AgentCheckpoint {
  @PrimaryGeneratedColumn()
  id: number;

  /** = conversationId */
  @Column({ name: 'thread_id', length: 36 })
  threadId: string;

  @Column({ name: 'checkpoint_ns', length: 255, default: '' })
  checkpointNs: string;

  @Column({ name: 'checkpoint_id', length: 36 })
  checkpointId: string;

  @Column({ name: 'parent_checkpoint_id', length: 36, nullable: true })
  parentCheckpointId: string | null;

  /** base64 编码的序列化 Checkpoint */
  @Column({ type: 'mediumtext' })
  checkpoint: string;

  /** base64 编码的序列化 CheckpointMetadata */
  @Column({ name: 'checkpoint_metadata', type: 'mediumtext', nullable: true })
  checkpointMetadata: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
