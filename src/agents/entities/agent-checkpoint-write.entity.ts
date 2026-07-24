import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * LangGraph pending writes（节点中间写入）。
 * 由 TypeORMCheckpointer.putWrites 写入，getTuple 时随快照读出。
 *
 * 设计文档未单独列此表（原方案挂在 checkpoint 同行列），但 putWrites 被调用时
 * 对应 checkpoint 行可能尚未写入，独立表是 LangGraph 官方各 saver 的通用做法。
 */
@Entity('agent_checkpoint_writes')
@Index(['threadId', 'checkpointNs', 'checkpointId', 'taskId', 'idx'], {
  unique: true,
})
export class AgentCheckpointWrite {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'thread_id', length: 36 })
  threadId: string;

  @Column({ name: 'checkpoint_ns', length: 255, default: '' })
  checkpointNs: string;

  @Column({ name: 'checkpoint_id', length: 36 })
  checkpointId: string;

  @Column({ name: 'task_id', length: 36 })
  taskId: string;

  /** 写入序号（WRITES_IDX_MAP 特殊通道为负数） */
  @Column({ type: 'int' })
  idx: number;

  @Column({ length: 255 })
  channel: string;

  /** base64 编码的序列化写入值 */
  @Column({ type: 'mediumtext' })
  value: string;
}
