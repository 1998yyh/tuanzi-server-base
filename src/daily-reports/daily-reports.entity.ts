import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum DailyReportType {
  AI = 'ai',
  STOCK = 'stock',
}

@Entity('daily_reports')
@Index(['type', 'date'], { unique: true })
export class DailyReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: DailyReportType,
    default: DailyReportType.AI,
  })
  type: DailyReportType;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'date' })
  date: string;

  @Column({ type: 'text' })
  content: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}