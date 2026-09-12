import { NotFoundException } from '@nestjs/common';
import { StockAlertsService } from 'src/stock-alerts/stock-alerts.service';

describe('StockAlertsService', () => {
  const repo = {
    create: jest.fn((value) => ({ id: 'alert-1', enabled: true, version: 1, ...value })),
    save: jest.fn(async (value) => value),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
  };
  const eventRepo = { findOne: jest.fn(), update: jest.fn(), createQueryBuilder: jest.fn() };
  const dataSource = { transaction: jest.fn() };
  const market = { getQuotes: jest.fn(), getBars: jest.fn() };
  const service = new StockAlertsService(
    repo as any,
    eventRepo as any,
    dataSource as any,
    market as any,
  );

  beforeEach(() => jest.clearAllMocks());

  it('创建提醒时绑定当前用户并初始化去重状态', async () => {
    const result = await service.create('user-a', {
      code: '600000',
      field: 'price',
      operator: 'gte',
      threshold: 10,
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        lastMatch: null,
        lastBarTime: null,
        lastObservedAt: null,
        version: 1,
      }),
    );
    expect((result as Record<string, unknown>).userId).toBeUndefined();
  });

  it('不能读取或修改其他用户的提醒', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(
      service.update('user-b', 'd1a3f5b7-1234-4567-89ab-123456789abc', { enabled: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.remove('user-b', 'd1a3f5b7-1234-4567-89ab-123456789abc'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('已读操作幂等且按用户隔离', async () => {
    eventRepo.findOne.mockResolvedValue({
      id: 'event-1',
      userId: 'user-a',
      readAt: new Date('2026-09-11T00:00:00Z'),
    });
    const result = await service.markRead('user-a', 'event-1');
    expect(eventRepo.update).not.toHaveBeenCalled();
    expect(result.readAt).toBeTruthy();
  });

  it('事务失败时向上传递错误，不吞掉原子写入失败', async () => {
    const alertUpdate = jest.fn();
    const alertTransactionRepo = {
      createQueryBuilder: () => ({
        setLock: () => ({
          where: () => ({
            getOne: async () => ({
              id: 'alert-1',
              userId: 'user-a',
              code: '600000',
              field: 'price',
              operator: 'gte',
              threshold: 10,
              enabled: true,
              lastMatch: false,
              lastBarTime: null,
              version: 1,
            }),
          }),
        }),
      }),
      update: alertUpdate,
    };
    const eventTransactionRepo = {
      create: jest.fn((value) => value),
      save: jest.fn().mockRejectedValue(new Error('insert failed')),
    };
    dataSource.transaction.mockImplementation(async (callback) =>
      callback({
        getRepository: (entity: { name: string }) =>
          entity.name === 'StockAlert' ? alertTransactionRepo : eventTransactionRepo,
      }),
    );
    await expect(service.applyObservation('alert-1', { value: 11 }, new Date())).rejects.toThrow(
      'insert failed',
    );
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('停用状态在事务行锁内重新确认，不生成事件', async () => {
    const update = jest.fn();
    const save = jest.fn();
    dataSource.transaction.mockImplementation(async (callback) =>
      callback({
        getRepository: (entity: { name: string }) =>
          entity.name === 'StockAlert'
            ? {
                createQueryBuilder: () => ({
                  setLock: () => ({
                    where: () => ({ getOne: async () => ({ id: 'alert-1', enabled: false }) }),
                  }),
                }),
                update,
              }
            : { create: jest.fn(), save },
      }),
    );
    await service.applyObservation('alert-1', { value: 11 }, new Date());
    expect(save).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('陈旧报价不会进入事务，因此不会重置去重状态', async () => {
    repo.find.mockResolvedValue([{ id: 'alert-1', code: '600000', field: 'price', enabled: true }]);
    market.getQuotes.mockResolvedValue({
      items: [{ code: '600000', price: 11, change: 1, asOf: '2020-01-01T00:00:00.000Z' }],
    });
    await service.monitor();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('报价时间戳为空时视为 unknown', async () => {
    repo.find.mockResolvedValue([{ id: 'alert-1', code: '600000', field: 'price', enabled: true }]);
    market.getQuotes.mockResolvedValue({
      items: [{ code: '600000', price: 11, change: 1, asOf: null }],
    });
    await service.monitor();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('事务拒绝重复或倒退的报价时间', async () => {
    const update = jest.fn();
    dataSource.transaction.mockImplementation(async (callback) =>
      callback({
        getRepository: (entity: { name: string }) =>
          entity.name === 'StockAlert'
            ? {
                createQueryBuilder: () => ({
                  setLock: () => ({
                    where: () => ({
                      getOne: async () => ({
                        id: 'alert-1',
                        enabled: true,
                        lastObservedAt: '2026-09-11T02:00:00.000Z',
                      }),
                    }),
                  }),
                }),
                update,
              }
            : { create: jest.fn(), save: jest.fn() },
      }),
    );
    await service.applyObservation(
      'alert-1',
      { value: 11, observedAt: '2026-09-11T01:59:00.000Z' },
      new Date(),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('事务拒绝重复或倒退的日线 bar', async () => {
    const update = jest.fn();
    dataSource.transaction.mockImplementation(async (callback) =>
      callback({
        getRepository: (entity: { name: string }) =>
          entity.name === 'StockAlert'
            ? {
                createQueryBuilder: () => ({
                  setLock: () => ({
                    where: () => ({
                      getOne: async () => ({
                        id: 'alert-1',
                        enabled: true,
                        lastBarTime: '2026-09-11',
                      }),
                    }),
                  }),
                }),
                update,
              }
            : { create: jest.fn(), save: jest.fn() },
      }),
    );
    await service.applyObservation(
      'alert-1',
      { previousValue: -1, currentValue: 1, barTime: '2026-09-09' },
      new Date(),
    );
    expect(update).not.toHaveBeenCalled();
  });
});
