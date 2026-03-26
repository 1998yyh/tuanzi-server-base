import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Novel, NovelStatus } from './novel.entity';
import { Chapter } from './chapter.entity';
import {
  CreateNovelDto,
  UpdateNovelDto,
  QueryNovelDto,
  CreateChapterDto,
  UpdateChapterDto,
  QueryChapterDto,
} from './dto';

@Injectable()
export class NovelsService {
  constructor(
    @InjectRepository(Novel)
    private novelRepository: Repository<Novel>,
    @InjectRepository(Chapter)
    private chapterRepository: Repository<Chapter>,
    private dataSource: DataSource,
  ) {}

  // ========== 小说 CRUD ==========

  async create(createDto: CreateNovelDto): Promise<Novel> {
    const novel = this.novelRepository.create(createDto);
    return this.novelRepository.save(novel);
  }

  async findAll(query: QueryNovelDto) {
    const { page = 1, limit = 10, status } = query;

    const qb = this.novelRepository.createQueryBuilder('novel');

    if (status !== undefined) {
      qb.andWhere('novel.status = :status', { status });
    }

    qb.orderBy('novel.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: number): Promise<Novel> {
    const novel = await this.novelRepository.findOne({ where: { id } });
    if (!novel) {
      throw new NotFoundException(`小说 #${id} 不存在`);
    }
    return novel;
  }

  async update(id: number, updateDto: UpdateNovelDto): Promise<Novel> {
    const novel = await this.findOne(id);
    Object.assign(novel, updateDto);
    return this.novelRepository.save(novel);
  }

  async remove(id: number): Promise<void> {
    const novel = await this.findOne(id);
    await this.novelRepository.remove(novel);
  }

  // ========== 章节相关 ==========

  async findChapters(novelId: number, query: QueryChapterDto) {
    const { page = 1, limit = 50 } = query;

    await this.findOne(novelId); // 确保小说存在

    const qb = this.chapterRepository
      .createQueryBuilder('chapter')
      .where('chapter.novelId = :novelId', { novelId })
      .select(['chapter.id', 'chapter.title', 'chapter.wordCount', 'chapter.chapterOrder', 'chapter.createdAt'])
      .orderBy('chapter.chapterOrder', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findChapter(novelId: number, chapterId: number): Promise<Chapter> {
    await this.findOne(novelId); // 确保小说存在

    const chapter = await this.chapterRepository.findOne({
      where: { id: chapterId, novelId },
    });

    if (!chapter) {
      throw new NotFoundException(`章节 #${chapterId} 不存在`);
    }

    return chapter;
  }

  async createChapter(novelId: number, createDto: CreateChapterDto): Promise<Chapter> {
    const novel = await this.findOne(novelId);

    // 检查章节序号是否已存在
    const existingChapter = await this.chapterRepository.findOne({
      where: { novelId, chapterOrder: createDto.chapterOrder },
    });

    if (existingChapter) {
      throw new ConflictException(`章节序号 ${createDto.chapterOrder} 已存在`);
    }

    // 计算字数
    const wordCount = createDto.content.length;

    // 使用事务创建章节并更新小说统计
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 创建章节
      const chapter = queryRunner.manager.create(Chapter, {
        ...createDto,
        novelId,
        wordCount,
      });
      const savedChapter = await queryRunner.manager.save(chapter);

      // 更新小说统计
      novel.chapterCount += 1;
      novel.wordCount += wordCount;
      await queryRunner.manager.save(novel);

      await queryRunner.commitTransaction();
      return savedChapter;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async updateChapter(
    novelId: number,
    chapterId: number,
    updateDto: UpdateChapterDto,
  ): Promise<Chapter> {
    const chapter = await this.findChapter(novelId, chapterId);
    const novel = await this.findOne(novelId);

    const oldWordCount = chapter.wordCount;

    // 如果更新章节序号，检查是否冲突
    if (updateDto.chapterOrder && updateDto.chapterOrder !== chapter.chapterOrder) {
      const existingChapter = await this.chapterRepository.findOne({
        where: { novelId, chapterOrder: updateDto.chapterOrder },
      });
      if (existingChapter) {
        throw new ConflictException(`章节序号 ${updateDto.chapterOrder} 已存在`);
      }
    }

    // 计算新字数
    const newContent = updateDto.content ?? chapter.content;
    const newWordCount = newContent.length;

    // 使用事务更新章节和小说统计
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      Object.assign(chapter, updateDto, { wordCount: newWordCount });
      const updatedChapter = await queryRunner.manager.save(chapter);

      // 更新小说总字数
      novel.wordCount = novel.wordCount - oldWordCount + newWordCount;
      await queryRunner.manager.save(novel);

      await queryRunner.commitTransaction();
      return updatedChapter;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async removeChapter(novelId: number, chapterId: number): Promise<void> {
    const chapter = await this.findChapter(novelId, chapterId);
    const novel = await this.findOne(novelId);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.manager.remove(chapter);

      // 更新小说统计
      novel.chapterCount -= 1;
      novel.wordCount -= chapter.wordCount;
      await queryRunner.manager.save(novel);

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}