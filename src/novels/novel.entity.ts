import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Chapter } from './chapter.entity';

export enum NovelStatus {
  ONGOING = 0, // 连载中
  COMPLETED = 1, // 已完结
}

@Entity('novels')
export class Novel {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ length: 255, comment: '书名' })
  title: string;

  @Column({ length: 100, comment: '作者' })
  author: string;

  @Column({ type: 'text', nullable: true, comment: '简介' })
  description: string;

  @Column({ name: 'cover_url', length: 500, nullable: true, comment: '封面图片URL' })
  coverUrl: string;

  @Column({ name: 'word_count', default: 0, comment: '总字数' })
  wordCount: number;

  @Column({ name: 'chapter_count', default: 0, comment: '章节数' })
  chapterCount: number;

  @Column({
    type: 'tinyint',
    default: NovelStatus.ONGOING,
    comment: '状态: 0-连载中, 1-已完结',
  })
  status: NovelStatus;

  @OneToMany(() => Chapter, (chapter) => chapter.novel, { cascade: true })
  chapters: Chapter[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}