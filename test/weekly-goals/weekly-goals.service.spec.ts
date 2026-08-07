import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { WeeklyGoalsService } from 'src/weekly-goals/weekly-goals.service';
import { WeeklyGoal, WeeklyGoalStatus } from 'src/weekly-goals/weekly-goals.entity';
import { NotFoundException, ConflictException } from '@nestjs/common';

describe('WeeklyGoalsService', () => {
  let service: WeeklyGoalsService;
  let repository: jest.Mocked<Repository<WeeklyGoal>>;
  let queryBuilder: {
    insert: jest.Mock;
    update: jest.Mock;
    values: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    execute: jest.Mock;
  };

  const userId = 'user-uuid';

  const mockGoal: WeeklyGoal = {
    id: 'goal-uuid',
    userId,
    title: '读完《纳瓦尔宝典》',
    note: null,
    dueDate: new Date('2026-08-13T14:30:00Z'),
    completedAt: null,
    createdAt: new Date('2026-08-06T14:30:00Z'),
    updatedAt: new Date('2026-08-06T14:30:00Z'),
    deletedAt: null,
  };

  beforeEach(async () => {
    const mockQueryBuilder = {
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ identifiers: [{ id: mockGoal.id }] }),
    };

    const mockRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      softRemove: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyGoalsService,
        {
          provide: getRepositoryToken(WeeklyGoal),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<WeeklyGoalsService>(WeeklyGoalsService);
    repository = module.get(getRepositoryToken(WeeklyGoal));
    queryBuilder = mockQueryBuilder;
  });

  describe('create', () => {
    it('应该由数据库时钟生成截止日期（created_at + 7 天）', async () => {
      repository.findOne.mockResolvedValue(mockGoal);

      const result = await service.create(userId, { title: '读完《纳瓦尔宝典》' });

      expect(repository.createQueryBuilder).toHaveBeenCalled();
      expect(queryBuilder.insert).toHaveBeenCalled();
      const values = queryBuilder.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.userId).toBe(userId);
      expect(values.title).toBe('读完《纳瓦尔宝典》');
      expect(typeof values.dueDate).toBe('function');
      expect((values.dueDate as () => string)()).toContain('INTERVAL 7 DAY');
      expect(result).toEqual(mockGoal);
    });
  });

  describe('findAll', () => {
    it('进行中：completedAt 为空，按截止日升序', async () => {
      repository.find.mockResolvedValue([mockGoal]);

      const result = await service.findAll(userId, {});

      expect(repository.find).toHaveBeenCalledWith({
        where: { userId, completedAt: IsNull() },
        order: { dueDate: 'ASC', createdAt: 'ASC' },
      });
      expect(result).toEqual([mockGoal]);
    });

    it('已完成：completedAt 非空，按完成时间倒序', async () => {
      repository.find.mockResolvedValue([]);

      await service.findAll(userId, { status: WeeklyGoalStatus.COMPLETED });

      expect(repository.find).toHaveBeenCalledWith({
        where: { userId, completedAt: Not(IsNull()) },
        order: { completedAt: 'DESC' },
      });
    });
  });

  describe('complete', () => {
    it('应该用数据库时钟打上完成时间戳', async () => {
      repository.findOne
        .mockResolvedValueOnce({ ...mockGoal })
        .mockResolvedValueOnce({ ...mockGoal, completedAt: new Date() });

      const result = await service.complete(userId, mockGoal.id);

      expect(queryBuilder.update).toHaveBeenCalled();
      expect(queryBuilder.set).toHaveBeenCalledWith({
        completedAt: expect.any(Function),
      });
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', { id: mockGoal.id });
      expect(result.completedAt).toBeInstanceOf(Date);
    });

    it('已完成的目标再次完成应该抛 409', async () => {
      repository.findOne.mockResolvedValue({ ...mockGoal, completedAt: new Date() });

      await expect(service.complete(userId, mockGoal.id)).rejects.toThrow(ConflictException);
    });

    it('目标不存在或不属于当前用户应该抛 404', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.complete(userId, 'other-uuid')).rejects.toThrow(NotFoundException);
    });
  });

  describe('uncomplete', () => {
    it('应该清空完成时间戳退回进行中', async () => {
      repository.findOne.mockResolvedValue({ ...mockGoal, completedAt: new Date() });
      repository.save.mockImplementation((goal) => Promise.resolve(goal as WeeklyGoal));

      const result = await service.uncomplete(userId, mockGoal.id);

      expect(result.completedAt).toBeNull();
    });

    it('进行中的目标无法撤销完成，应该抛 409', async () => {
      repository.findOne.mockResolvedValue({ ...mockGoal });

      await expect(service.uncomplete(userId, mockGoal.id)).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('应该软删除目标', async () => {
      repository.findOne.mockResolvedValue({ ...mockGoal });
      repository.softRemove.mockResolvedValue(mockGoal);

      await service.remove(userId, mockGoal.id);

      expect(repository.softRemove).toHaveBeenCalled();
    });

    it('目标不存在应该抛 404', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.remove(userId, 'other-uuid')).rejects.toThrow(NotFoundException);
    });
  });
});
