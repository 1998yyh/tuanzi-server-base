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
import { User } from '../users/users.entity';

/**
 * 提示词源：user_id 为 null 表示内置源（所有用户共享、只读），
 * 否则为用户自建源。Prompt 内容本身不入库——服务层抓取源 URL + 内存缓存。
 */
@Entity('prompt_sources')
@Index(['userId'])
export class PromptSource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  /** null = 内置源 */
  @Column({ name: 'user_id', type: 'varchar', length: 36, nullable: true })
  userId: string | null;

  @Column({ length: 100 })
  name: string;

  /** 源 JSON 地址（数组格式，见 lib/prompt-normalize） */
  @Column({ length: 500 })
  url: string;

  @Column({ length: 500, default: '' })
  homepage: string;

  @Column({ name: 'is_builtin', default: false })
  isBuiltin: boolean;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** API 响应形状：user 关系对象不出现在响应中 */
export type PromptSourceView = Omit<PromptSource, 'user'>;
