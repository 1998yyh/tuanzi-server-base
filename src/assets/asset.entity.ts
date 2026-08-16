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
import { MediaFile } from '../media/media-file.entity';

/** 素材类型 */
export enum AssetKind {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
}

/**
 * 素材库：用户收藏的提示词文本/图片/视频。
 * 文本内容直接存 textContent；图片/视频存 media_files 引用。
 */
@Entity('assets')
@Index(['userId', 'kind'])
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ type: 'enum', enum: AssetKind })
  kind: AssetKind;

  @Column({ length: 200 })
  title: string;

  /** 文本素材内容（kind=text） */
  @Column({ name: 'text_content', type: 'text', nullable: true })
  textContent: string | null;

  /** 媒体素材引用（kind=image/video） */
  @ManyToOne(() => MediaFile, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'media_id' })
  media: MediaFile | null;

  @Column({ name: 'media_id', type: 'varchar', length: 36, nullable: true })
  mediaId: string | null;

  @Column({ type: 'json', nullable: true })
  tags: string[] | null;

  /** 来源说明（如提示词库条目名） */
  @Column({ length: 200, default: '' })
  source: string;

  @Column({ length: 500, default: '' })
  note: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
