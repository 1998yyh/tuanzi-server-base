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
import { AgentConfig } from '../entities/agent-config.entity';
import { DailyReportType } from '../../daily-reports/daily-reports.entity';

/**
 * Agent 定时任务：按 cron 表达式触发 Agent 自动执行（如每日生成日报）。
 * 同一 agentConfigId + reportType 下最多 1 个活跃任务（代码层校验，见 ScheduledTasksService）。
 */
@Entity('agent_scheduled_tasks')
@Index(['agentConfigId', 'isActive'])
export class ScheduledTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => AgentConfig, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_config_id' })
  agentConfig: AgentConfig;

  @Column({ name: 'agent_config_id' })
  agentConfigId: string;

  @Column({ name: 'report_type', type: 'enum', enum: DailyReportType })
  reportType: DailyReportType;

  /** cron 表达式（如 "0 8 * * *"），按 Asia/Shanghai 时区调度 */
  @Column({ name: 'cron_expression', length: 100 })
  cronExpression: string;

  /** 任务描述：定时触发时拼接为 Agent 的执行指令 */
  @Column({ length: 255 })
  description: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'last_run_at', type: 'datetime', nullable: true })
  lastRunAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
