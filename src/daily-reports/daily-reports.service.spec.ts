import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyReportsService } from './daily-reports.service';
import { DailyReport, DailyReportType } from './daily-reports.entity';
import { NotFoundException } from '@nestjs/common';

describe('DailyReportsService', () => {
  let service: DailyReportsService;
  let repository: jest.Mocked<Repository<DailyReport>>;

  const mockReport: DailyReport = {
    id: 'test-uuid',
    type: DailyReportType.AI,
    title: 'AI情报早报 | 2026-03-16',
    date: '2026-03-16',
    content: '# 测试内容',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyReportsService,
        {
          provide: getRepositoryToken(DailyReport),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<DailyReportsService>(DailyReportsService);
    repository = module.get(getRepositoryToken(DailyReport));
  });

  describe('create', () => {
    it('应该成功创建日报', async () => {
      const createDto = {
        type: DailyReportType.AI,
        title: 'AI情报早报 | 2026-03-16',
        date: '2026-03-16',
        content: '# 测试内容',
      };

      repository.create.mockReturnValue(mockReport);
      repository.save.mockResolvedValue(mockReport);

      const result = await service.create(createDto);

      expect(repository.create).toHaveBeenCalledWith(createDto);
      expect(repository.save).toHaveBeenCalledWith(mockReport);
      expect(result).toEqual(mockReport);
    });
  });

  describe('findAll', () => {
    it('应该返回分页的日报列表', async () => {
      const mockQueryBuilder = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[mockReport], 1]),
      };

      repository.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const result = await service.findAll({ page: 1, limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);
    });

    it('应该支持按类型筛选', async () => {
      const mockQueryBuilder = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[mockReport], 1]),
      };

      repository.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      await service.findAll({ type: DailyReportType.AI, page: 1, limit: 10 });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('report.type = :type', {
        type: DailyReportType.AI,
      });
    });

    it('应该支持按日期筛选', async () => {
      const mockQueryBuilder = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[mockReport], 1]),
      };

      repository.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      await service.findAll({ date: '2026-03-16', page: 1, limit: 10 });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('report.date = :date', {
        date: '2026-03-16',
      });
    });
  });

  describe('findOne', () => {
    it('应该返回指定 ID 的日报', async () => {
      repository.findOne.mockResolvedValue(mockReport);

      const result = await service.findOne('test-uuid');

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'test-uuid' } });
      expect(result).toEqual(mockReport);
    });

    it('日报不存在时应抛出 NotFoundException', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
      await expect(service.findOne('nonexistent')).rejects.toThrow('日报 #nonexistent 不存在');
    });
  });

  describe('findByTypeAndDate', () => {
    it('应该返回指定类型和日期的日报', async () => {
      repository.findOne.mockResolvedValue(mockReport);

      const result = await service.findByTypeAndDate(DailyReportType.AI, '2026-03-16');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { type: DailyReportType.AI, date: '2026-03-16' },
      });
      expect(result).toEqual(mockReport);
    });

    it('不存在时返回 null', async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.findByTypeAndDate(DailyReportType.AI, '2026-03-15');

      expect(result).toBeNull();
    });
  });

  describe('getLatestByType', () => {
    it('应该返回指定类型的最新日报', async () => {
      repository.findOne.mockResolvedValue(mockReport);

      const result = await service.getLatestByType(DailyReportType.AI);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { type: DailyReportType.AI },
        order: { date: 'DESC' },
      });
      expect(result).toEqual(mockReport);
    });
  });

  describe('getDatesByType', () => {
    it('应该返回指定类型的所有日期列表', async () => {
      const reports = [
        { date: '2026-03-16' },
        { date: '2026-03-15' },
        { date: '2026-03-14' },
      ];

      repository.find.mockResolvedValue(reports as any);

      const result = await service.getDatesByType(DailyReportType.AI);

      expect(repository.find).toHaveBeenCalledWith({
        where: { type: DailyReportType.AI },
        select: ['date'],
        order: { date: 'DESC' },
      });
      expect(result).toEqual(['2026-03-16', '2026-03-15', '2026-03-14']);
    });
  });

  describe('update', () => {
    it('应该成功更新日报', async () => {
      const updateDto = { title: '新标题' };
      const updatedReport = { ...mockReport, title: '新标题' };

      repository.findOne.mockResolvedValue(mockReport);
      repository.save.mockResolvedValue(updatedReport);

      const result = await service.update('test-uuid', updateDto);

      expect(result.title).toBe('新标题');
    });
  });

  describe('remove', () => {
    it('应该成功删除日报', async () => {
      repository.findOne.mockResolvedValue(mockReport);
      repository.remove.mockResolvedValue(mockReport);

      await service.remove('test-uuid');

      expect(repository.remove).toHaveBeenCalledWith(mockReport);
    });

    it('删除不存在的日报时应抛出 NotFoundException', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.remove('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});