import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { StrategyDefinition } from './strategy-definition';
export interface StrategyRevision {
  version: number;
  name: string;
  definition: StrategyDefinition;
  savedAt: string;
}
@Entity('stock_strategies')
@Index(['userId', 'name'], { unique: true })
export class StockStrategy {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'varchar', length: 36 }) userId: string;
  @Column({ type: 'varchar', length: 80 }) name: string;
  @Column({ type: 'int', unsigned: true, default: 1 }) version: number;
  @Column({ type: 'json' }) definition: StrategyDefinition;
  @Column({ type: 'json' }) revisions: StrategyRevision[];
  @Column({ name: 'deleted_at', type: 'datetime', nullable: true }) deletedAt: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
