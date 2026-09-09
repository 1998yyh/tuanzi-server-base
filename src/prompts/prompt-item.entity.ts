import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RawPrompt } from './lib/prompt-normalize';

@Entity('prompt_items')
@Index(['userId', 'category'])
@Index(['sourceId'])
@Index(['maintainerId'])
export class PromptItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** null 为管理员维护的公共库，其他值为用户私有源导入内容。 */
  @Column({ name: 'user_id', type: 'varchar', length: 36, nullable: true })
  userId: string | null;

  /** 公共条目的维护者，仅获得词库维护权，不修改 UserRole。 */
  @Column({ name: 'maintainer_id', type: 'varchar', length: 36, nullable: true })
  maintainerId: string | null;

  @Column({ name: 'source_id', type: 'varchar', length: 36, nullable: true })
  sourceId: string | null;

  /** 包含删除记录的唯一导入标识，防止重复导入覆盖编辑或恢复删除项。 */
  @Column({ name: 'import_key', type: 'char', length: 64, nullable: true, unique: true })
  importKey: string | null;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'longtext' })
  prompt: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ length: 100, default: '其他创意' })
  category: string;

  @Column({ type: 'json' })
  tags: string[];

  /** 图片、作者及生成参数；正文与可检索字段单独存储。 */
  @Column({ type: 'json' })
  metadata: Partial<RawPrompt> & { githubUrl?: string; sourceName?: string };

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt: Date | null;
}
