import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NovelsService } from './novels.service';
import { Novel, NovelStatus } from './novel.entity';
import { Chapter } from './chapter.entity';
import { NotFoundException, ConflictException } from '@nestjs/common';

describe('NovelsService', () => {
  let service: NovelsService;

  const mockNovelRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockChapterRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      save: jest.fn(),
      remove: jest.fn(),
      create: jest.fn(),
    },
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NovelsService,
        { provide: getRepositoryToken(Novel), useValue: mockNovelRepository },
        { provide: getRepositoryToken(Chapter), useValue: mockChapterRepository },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<NovelsService>(NovelsService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new novel', async () => {
      const createDto = { title: 'Test Novel', author: 'Test Author' };
      const novel = { id: 1, ...createDto, wordCount: 0, chapterCount: 0 };

      mockNovelRepository.create.mockReturnValue(novel);
      mockNovelRepository.save.mockResolvedValue(novel);

      const result = await service.create(createDto);

      expect(result).toEqual(novel);
      expect(mockNovelRepository.create).toHaveBeenCalledWith(createDto);
    });
  });

  describe('findOne', () => {
    it('should return a novel by id', async () => {
      const novel = { id: 1, title: 'Test Novel', author: 'Test Author' };
      mockNovelRepository.findOne.mockResolvedValue(novel);

      const result = await service.findOne(1);

      expect(result).toEqual(novel);
    });

    it('should throw NotFoundException if novel not found', async () => {
      mockNovelRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update an existing novel', async () => {
      const existingNovel = { id: 1, title: 'Old Title', author: 'Author' };
      const updateDto = { title: 'New Title' };
      const updatedNovel = { ...existingNovel, ...updateDto };

      mockNovelRepository.findOne.mockResolvedValue(existingNovel);
      mockNovelRepository.save.mockResolvedValue(updatedNovel);

      const result = await service.update(1, updateDto);

      expect(result.title).toBe('New Title');
    });
  });

  describe('remove', () => {
    it('should remove a novel', async () => {
      const novel = { id: 1, title: 'To Delete' };
      mockNovelRepository.findOne.mockResolvedValue(novel);
      mockNovelRepository.remove.mockResolvedValue(novel);

      await service.remove(1);

      expect(mockNovelRepository.remove).toHaveBeenCalledWith(novel);
    });

    it('should throw NotFoundException if novel not found', async () => {
      mockNovelRepository.findOne.mockResolvedValue(null);

      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findChapter', () => {
    it('should return a chapter by id', async () => {
      const novel = { id: 1, title: 'Novel' };
      const chapter = { id: 1, novelId: 1, title: 'Chapter 1', content: 'Content' };
      
      mockNovelRepository.findOne.mockResolvedValue(novel);
      mockChapterRepository.findOne.mockResolvedValue(chapter);

      const result = await service.findChapter(1, 1);

      expect(result).toEqual(chapter);
    });
  });

  describe('createChapter', () => {
    it('should create a new chapter and update novel stats', async () => {
      const createDto = { title: 'New Chapter', content: 'Content', chapterOrder: 1 };
      const novel = { id: 1, title: 'Novel', chapterCount: 0, wordCount: 0 };
      const chapter = { id: 1, novelId: 1, ...createDto, wordCount: 7 };

      mockNovelRepository.findOne.mockResolvedValue(novel);
      mockChapterRepository.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.create.mockReturnValue(chapter);
      mockQueryRunner.manager.save.mockResolvedValue(chapter);
      mockNovelRepository.save.mockResolvedValue({ ...novel, chapterCount: 1, wordCount: 7 });

      const result = await service.createChapter(1, createDto);

      expect(result).toEqual(chapter);
    });

    it('should throw ConflictException if chapter order exists', async () => {
      const createDto = { title: 'New Chapter', content: 'Content', chapterOrder: 1 };
      const novel = { id: 1, title: 'Novel' };
      const existingChapter = { id: 1, chapterOrder: 1 };

      mockNovelRepository.findOne.mockResolvedValue(novel);
      mockChapterRepository.findOne.mockResolvedValue(existingChapter);

      await expect(service.createChapter(1, createDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('removeChapter', () => {
    it('should remove a chapter', async () => {
      const novel = { id: 1, chapterCount: 2, wordCount: 100 };
      const chapter = { id: 1, novelId: 1, title: 'To Delete', wordCount: 50 };

      mockNovelRepository.findOne.mockResolvedValue(novel);
      mockChapterRepository.findOne.mockResolvedValue(chapter);

      await service.removeChapter(1, 1);

      expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
    });
  });
});