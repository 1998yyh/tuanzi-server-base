import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type StockMarket = 'sh' | 'sz';

/**
 * 股票每日信号全量表：每次扫描把当日全部股票的新浪多空信号原值落库（约 3044 行/日），
 * value === '1' 即 B（买入）信号。UNIQUE(signal_date, code) 保证幂等 upsert。
 */
@Entity('stock_signals')
@Index(['signalDate', 'code'], { unique: true })
export class StockSignal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 信号日期（YYYY-MM-DD） */
  @Column({ name: 'signal_date', type: 'date' })
  signalDate: string;

  /** 6 位股票代码 */
  @Column({ type: 'char', length: 6 })
  code: string;

  @Column({ type: 'enum', enum: ['sh', 'sz'] })
  market: StockMarket;

  @Column({ length: 50 })
  name: string;

  /** 新浪信号原值（'1' = B，其余原样保留） */
  @Column({ length: 10 })
  value: string;

  /** 产生本行数据的扫描任务（指定代码补抓时为 null） */
  @Column({ name: 'run_id', type: 'varchar', length: 36, nullable: true })
  runId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
