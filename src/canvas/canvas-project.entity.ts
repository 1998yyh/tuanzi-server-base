import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { CanvasDocument } from './canvas.types';

/**
 * 画布项目：整个文档（nodes + connections + viewport）存单个 JSON 列，
 * version 为乐观锁——所有写路径（前端整文档保存 / Agent ops / 生成回填）
 * 都经 CanvasDocumentService.applyMutation 走 UPDATE ... WHERE version=? 。
 */
@Entity('canvas_projects')
export class CanvasProject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ length: 200 })
  name: string;

  @Column({ type: 'json' })
  document: CanvasDocument;

  /** 乐观锁版本号，每次变更 +1 */
  @Column({ default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** API 响应形状：user 关系对象不出现在响应中 */
export type CanvasProjectView = Omit<CanvasProject, 'user'>;

/** 列表项形状：不含完整文档，只有摘要 */
export type CanvasProjectSummary = Omit<CanvasProjectView, 'document'> & {
  nodeCount: number;
  connectionCount: number;
};
