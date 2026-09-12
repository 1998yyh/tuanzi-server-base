import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type AlertDeliveryStatus = 'queued';

@Entity('stock_alert_events')
@Index(['userId', 'createdAt'])
@Index(['alertId', 'alertVersion'], { unique: true })
export class StockAlertEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'alert_id', type: 'varchar', length: 36 }) alertId: string;
  @Column({ name: 'alert_version', type: 'int', unsigned: true }) alertVersion: number;
  @Column({ name: 'user_id', type: 'varchar', length: 36 }) userId: string;
  @Column({ type: 'char', length: 6 }) code: string;
  @Column({ type: 'varchar', length: 255 }) message: string;
  @Column({ name: 'read_at', type: 'datetime', nullable: true }) readAt: Date | null;
  @Column({ name: 'delivery_status', type: 'varchar', length: 16, default: 'queued' })
  deliveryStatus: AlertDeliveryStatus;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
