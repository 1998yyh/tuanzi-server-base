import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { StrategyDefinition } from '../stock-strategies/strategy-definition';
import type { IndicatorRow } from '../stock-market/market.types';

export enum ScreeningRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
}
export interface ScreeningResultItem {
  code: string;
  name: string;
  match: boolean;
  conditions?: boolean[];
  dataGap?: string;
  price?: number;
  barTime?: string;
  source?: string;
  fetchedAt?: string;
  indicators?: IndicatorRow;
}

@Entity('stock_screening_runs')
@Index(['userId', 'createdAt'])
export class StockScreeningRun {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'varchar', length: 36 }) userId: string;
  @Column({ name: 'strategy_id', type: 'varchar', length: 36 }) strategyId: string;
  @Column({ name: 'strategy_snapshot', type: 'json' }) strategySnapshot: StrategyDefinition;
  @Column({ type: 'enum', enum: ScreeningRunStatus, default: ScreeningRunStatus.QUEUED })
  status: ScreeningRunStatus;
  @Column({ name: 'as_of', type: 'datetime' }) asOf: Date;
  @Column({ name: 'target_snapshot', type: 'json' }) targetSnapshot: Array<{
    code: string;
    name: string;
  }>;
  @Column({ name: 'sampled_at', type: 'datetime', nullable: true }) sampledAt: Date | null;
  @Column({ type: 'int', default: 0 }) total: number;
  @Column({ type: 'int', default: 0 }) checked: number;
  @Column({ type: 'int', default: 0 }) matched: number;
  @Column({ type: 'json', nullable: true }) items: ScreeningResultItem[] | null;
  @Column({ name: 'data_gaps', type: 'json', nullable: true }) dataGaps: Array<{
    code: string;
    reason: string;
  }> | null;
  @Column({ name: 'catalog_coverage', type: 'varchar', length: 120, nullable: true })
  catalogCoverage: string | null;
  @Column({ name: 'error_message', type: 'varchar', length: 255, nullable: true }) errorMessage:
    | string
    | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
