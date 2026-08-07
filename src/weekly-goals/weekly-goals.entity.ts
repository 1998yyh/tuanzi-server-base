import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

/** 周目标状态：进行中 / 已完成（归档） */
export enum WeeklyGoalStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
}

@Entity('weekly_goals')
export class WeeklyGoal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // 索引名显式指定：与 migration 里的名字对齐，避免 TypeORM 哈希命名导致 generate 误判漂移
  @Index('IDX_weekly_goals_user_id')
  @Column({ name: 'user_id' })
  userId: string;

  @Column({ length: 100 })
  title: string;

  /** 备注（可选，给未来的自己留上下文） */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** 截止日期：创建时由后端生成 = 创建时间 + 7 天，不可修改 */
  @Column({ name: 'due_date', type: 'datetime' })
  dueDate: Date;

  /** 完成时间：null 表示进行中，非 null 即已归档 */
  @Column({ name: 'completed_at', type: 'datetime', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt: Date | null;
}
