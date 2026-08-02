import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ScanRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
}

/**
 * 全市场扫描任务：一次「某日全市场 B 信号扫描」的执行记录与进度载体。
 * 同一日期可有多个 run（强制刷新会产生新 run），结果展示取该日期最新 done 的 run。
 */
@Entity('stock_signal_scan_runs')
@Index(['queryDate', 'status'])
export class StockSignalScanRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 查询的信号日期（YYYY-MM-DD，北京时间） */
  @Column({ name: 'query_date', type: 'date' })
  queryDate: string;

  @Column({ type: 'enum', enum: ScanRunStatus, default: ScanRunStatus.PENDING })
  status: ScanRunStatus;

  @Column({ type: 'int', default: 0 })
  total: number;

  @Column({ type: 'int', default: 0 })
  checked: number;

  /** 当日 B 信号（value='1'）数量 */
  @Column({ type: 'int', default: 0 })
  found: number;

  /** 抓取失败的股票代码（SH600000 形式） */
  @Column({ name: 'failed_codes', type: 'json', nullable: true })
  failedCodes: string[] | null;

  /** 触发人（扫描接口需登录） */
  @Column({ name: 'created_by', type: 'varchar', length: 36, nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
