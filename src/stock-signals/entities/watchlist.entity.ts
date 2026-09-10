import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { StockMarket } from './stock-signal.entity';

export enum WatchlistStatus {
  /** 观察中：入池后等待 S（卖出）信号 */
  WATCHING = 'watching',
  /** 已触发：入池依据日之后出现了 S 信号 */
  TRIGGERED = 'triggered',
}

/**
 * 股票观察池：用户把 B 信号命中的股票入池，之后每个交易日由 cron 刷新全市场信号，
 * 若入池依据日之后出现 S 信号（value='0'）则置 triggered。
 * 单用户上限 100 只（service 层控制），UNIQUE(user_id, code) 防重复入池。
 * ⚠️ synchronize=false：建表 DDL 见 docs/plans/2026-08-25-stock-watchlist.sql，需手动执行。
 */
@Entity('stock_watchlist')
@Index(['userId', 'code'], { unique: true })
export class StockWatchlist {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 归属用户（JWT user id；不加外键，与 scan_run.created_by 同一风格） */
  @Index()
  @Column({ name: 'user_id', type: 'varchar', length: 36 })
  userId: string;

  /** 6 位股票代码 */
  @Column({ type: 'char', length: 6 })
  code: string;

  @Column({ type: 'enum', enum: ['sh', 'sz'] })
  market: StockMarket;

  @Column({ length: 50 })
  name: string;

  @Column({ type: 'enum', enum: WatchlistStatus, default: WatchlistStatus.WATCHING })
  status: WatchlistStatus;

  /** 入池依据的 B 信号日期（S 评估只认晚于该日期的信号） */
  @Column({ name: 'entry_signal_date', type: 'date' })
  entrySignalDate: string;

  /** 触发时的 S 信号日期（满足条件的最大 signal_date） */
  @Column({ name: 'triggered_signal_date', type: 'date', nullable: true })
  triggeredSignalDate: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
