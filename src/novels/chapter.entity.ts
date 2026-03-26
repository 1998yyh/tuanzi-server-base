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
import { Novel } from './novel.entity';

@Entity('chapters')
@Index(['novelId', 'chapterOrder'], { unique: true })
export class Chapter {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ name: 'novel_id', comment: '所属小说ID' })
  novelId: number;

  @Column({ length: 255, comment: '章节标题' })
  title: string;

  @Column({ type: 'longtext', comment: '章节内容' })
  content: string;

  @Column({ name: 'word_count', comment: '本章字数' })
  wordCount: number;

  @Column({ name: 'chapter_order', comment: '章节序号' })
  chapterOrder: number;

  @ManyToOne(() => Novel, (novel) => novel.chapters, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'novel_id' })
  novel: Novel;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}