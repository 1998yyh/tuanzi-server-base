import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
@Entity('stock_research_watchlist')
@Index(['userId', 'code'], { unique: true })
export class ResearchWatch {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'varchar', length: 36 }) userId: string;
  @Column({ type: 'char', length: 6 }) code: string;
  @Column({ length: 50 }) name: string;
  @Column({ type: 'text' }) reason: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
