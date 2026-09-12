import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { StockStrategy } from 'src/stock-strategies/stock-strategy.entity';
import { StockStrategiesService } from 'src/stock-strategies/stock-strategies.service';
const definition = {
  period: 'day',
  adjustment: 'qfq',
  scope: 'watchlist',
  match: 'all',
  conditions: [{ indicator: 'MA', parameters: [20] }],
};
describe('用户策略库', () => {
  let service: StockStrategiesService;
  let repo: Record<string, jest.Mock>;
  let qb: Record<string, jest.Mock>;
  const row = () => ({
    id: 's1',
    userId: 'u1',
    name: '原策略',
    version: 1,
    definition: structuredClone(definition),
    revisions: [
      {
        version: 1,
        name: '原策略',
        definition: structuredClone(definition),
        savedAt: '2026-09-12T00:00:00.000Z',
      },
    ],
    deletedAt: null,
  });
  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[row()], 1]),
    };
    repo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: 's1', ...x })),
      findOne: jest.fn().mockResolvedValue(row()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const module = await Test.createTestingModule({
      providers: [
        StockStrategiesService,
        { provide: getRepositoryToken(StockStrategy), useValue: repo },
      ],
    }).compile();
    service = module.get(StockStrategiesService);
  });
  it('创建时归属由服务端传入且保存首版快照', async () => {
    const result = await service.create('u1', { name: ' 我的策略 ', definition });
    expect(result).toMatchObject({
      userId: 'u1',
      name: '我的策略',
      version: 1,
      revisions: [{ version: 1, name: '我的策略', definition }],
    });
  });
  it('名称冲突返回409', async () => {
    repo.save.mockRejectedValue({ code: 'ER_DUP_ENTRY' });
    await expect(service.create('u1', { name: '重复', definition })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it('查不到或非本人统一404，查询带归属和未删除约束', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.get('u2', 's1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { id: 's1', userId: 'u2', deletedAt: IsNull() },
    });
  });
  it('列表分页仅查当前用户未删除策略', async () => {
    await expect(service.list('u1', 2, 10)).resolves.toMatchObject({
      total: 1,
      page: 2,
      limit: 10,
      totalPages: 1,
    });
    expect(qb.where).toHaveBeenCalledWith('strategy.userId = :userId', { userId: 'u1' });
    expect(qb.andWhere).toHaveBeenCalledWith('strategy.deletedAt IS NULL');
    expect(qb.skip).toHaveBeenCalledWith(10);
  });
  it('修改保留原快照并使用版本条件防止并发覆盖', async () => {
    const old = row();
    repo.findOne.mockResolvedValue(old);
    const result = await service.update('u1', 's1', { name: '新策略', definition, version: 1 });
    expect(old.revisions).toHaveLength(1);
    expect(result.version).toBe(2);
    expect(result.revisions).toHaveLength(2);
    expect(result.revisions[0].name).toBe('原策略');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 's1', userId: 'u1', version: 1, deletedAt: IsNull() },
      expect.objectContaining({ version: 2, name: '新策略' }),
    );
  });
  it('旧版本拒绝修改', async () => {
    await expect(
      service.update('u1', 's1', { name: '新策略', definition, version: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.update).not.toHaveBeenCalled();
  });
  it('并发写入失败返回409', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    await expect(
      service.update('u1', 's1', { name: '新策略', definition, version: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('修改名称冲突返回409', async () => {
    repo.update.mockRejectedValue({ driverError: { code: 'ER_DUP_ENTRY' } });
    await expect(
      service.update('u1', 's1', { name: '新策略', definition, version: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('删除为带版本条件的逻辑删除，保留历史', async () => {
    await service.remove('u1', 's1', 1);
    expect(repo.update).toHaveBeenCalledWith(
      { id: 's1', userId: 'u1', version: 1, deletedAt: IsNull() },
      expect.objectContaining({ deletedAt: expect.any(Date), version: 2 }),
    );
  });
  it('他人不可修改或删除', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(
      service.update('u2', 's1', { name: '新策略', definition, version: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('u2', 's1', 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.update).not.toHaveBeenCalled();
  });
});
