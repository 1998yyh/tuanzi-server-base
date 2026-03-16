import { Test, TestingModule } from '@nestjs/testing';
import { DailyReportsController } from './daily-reports.controller';
import { DailyReportsService } from './daily-reports.service';
import { DailyReport, DailyReportType } from './daily-reports.entity';

describe('DailyReportsController', () => {
  let controller: DailyReportsController;
  let service: jest.Mocked<DailyReportsService>;

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
    const mockService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      findByTypeAndDate: jest.fn(),
      getDatesByType: jest.fn(),
      getLatestByType: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DailyReportsController],
      providers: [
        {
          provide: DailyReportsService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<DailyReportsController>(DailyReportsController);
    service = module.get(DailyReportsService);
  });

  describe('create', () => {
    it('应该调用 service.create 并返回结果', async () => {
      const createDto = {
        type: DailyReportType.AI,
        title: 'AI情报早报 | 2026-03-16',
        date: '2026-03-16',
        content: '# 测试内容',
      };

      service.create.mockResolvedValue(mockReport);

      const result = await controller.create(createDto);

      expect(service.create).toHaveBeenCalledWith(createDto);
      expect(result).toEqual(mockReport);
    });
  });

  describe('findAll', () => {
    it('应该调用 service.findAll 并返回分页结果', async () => {
      const query = { page: 1, limit: 10 };
      const mockResponse = {
        items: [mockReport],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      service.findAll.mockResolvedValue(mockResponse);

      const result = await controller.findAll(query);

      expect(service.findAll).toHaveBeenCalledWith(query);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getDates', () => {
    it('应该返回指定类型的日期列表', async () => {
      const dates = ['2026-03-16', '2026-03-15'];
      service.getDatesByType.mockResolvedValue(dates);

      const result = await controller.getDates('ai');

      expect(service.getDatesByType).toHaveBeenCalledWith('ai');
      expect(result).toEqual(dates);
    });
  });

  describe('getLatest', () => {
    it('应该返回指定类型的最新日报', async () => {
      service.getLatestByType.mockResolvedValue(mockReport);

      const result = await controller.getLatest('ai');

      expect(service.getLatestByType).toHaveBeenCalledWith('ai');
      expect(result).toEqual(mockReport);
    });

    it('不存在时返回 null', async () => {
      service.getLatestByType.mockResolvedValue(null);

      const result = await controller.getLatest('stock');

      expect(result).toBeNull();
    });
  });

  describe('findOne', () => {
    it('应该返回指定 ID 的日报', async () => {
      service.findOne.mockResolvedValue(mockReport);

      const result = await controller.findOne('test-uuid');

      expect(service.findOne).toHaveBeenCalledWith('test-uuid');
      expect(result).toEqual(mockReport);
    });
  });

  describe('remove', () => {
    it('应该成功删除日报', async () => {
      service.remove.mockResolvedValue(undefined);

      await controller.remove('test-uuid');

      expect(service.remove).toHaveBeenCalledWith('test-uuid');
    });
  });
});