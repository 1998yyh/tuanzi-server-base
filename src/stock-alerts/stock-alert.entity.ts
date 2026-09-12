import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AlertField, AlertOperator } from './alert-evaluator';

@Entity('stock_alerts')
@Index(['userId', 'enabled'])
export class StockAlert {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'varchar', length: 36 }) userId: string;
  @Column({ type: 'char', length: 6 }) code: string;
  @Column({ type: 'varchar', length: 16 }) field: AlertField;
  @Column({ type: 'json', nullable: true }) parameters: number[] | null;
  @Column({ type: 'varchar', length: 3 }) operator: AlertOperator;
  @Column({ type: 'decimal', precision: 20, scale: 6 }) threshold: number;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ name: 'last_match', type: 'boolean', nullable: true }) lastMatch: boolean | null;
  @Column({ name: 'last_bar_time', type: 'varchar', length: 32, nullable: true }) lastBarTime:
    | string
    | null;
  @Column({ name: 'last_observed_at', type: 'varchar', length: 32, nullable: true })
  lastObservedAt: string | null;
  @Column({ type: 'int', unsigned: true, default: 1 }) version: number;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
