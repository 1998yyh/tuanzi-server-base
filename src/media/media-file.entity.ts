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

/** 媒体文件类型 */
export enum MediaKind {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  FILE = 'file',
}

/** 媒体来源：用户上传 / AI 生成 / 外部导入 */
export enum MediaSource {
  UPLOAD = 'upload',
  GENERATION = 'generation',
  IMPORT = 'import',
}

/**
 * 媒体文件：AI 生成结果与用户上传素材的统一存储。
 * 二进制落盘 ./uploads/media/，本表只存元数据；
 * fileName 即对外引用的 storageKey，url 冗余存储便于直接返回。
 */
@Entity('media_files')
@Index(['userId', 'kind'])
export class MediaFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ type: 'enum', enum: MediaKind })
  kind: MediaKind;

  /** 磁盘文件名（uuid + 扩展名），即 storageKey */
  @Column({ name: 'file_name', length: 200, unique: true })
  fileName: string;

  /** 静态访问地址，如 /uploads/media/<fileName> */
  @Column({ length: 500 })
  url: string;

  @Column({ name: 'mime_type', length: 100 })
  mimeType: string;

  @Column({ type: 'int', unsigned: true })
  bytes: number;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  @Column({ type: 'enum', enum: MediaSource })
  source: MediaSource;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** API 响应形状：user 关系对象不出现在响应中 */
export type MediaFileView = Omit<MediaFile, 'user'>;
