import { ConflictException, NotFoundException } from '@nestjs/common';
import { ResearchWatchService } from 'src/stock-research/research-watch.service';

describe('研究观察池', () => {
  const repo = { find: jest.fn(), create: jest.fn((v) => v), save: jest.fn(), delete: jest.fn() };
  const service = new ResearchWatchService(repo as never);
  beforeEach(() => jest.clearAllMocks());
  it('列表只查询当前用户', async () => {
    repo.find.mockResolvedValue([]);
    await service.list('u1');
    expect(repo.find).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      order: { updatedAt: 'DESC' },
    });
  });
  it('相同代码重复添加返回冲突，数据库异常不伪装为重复', async () => {
    repo.save.mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' });
    await expect(service.create('u1', { code: '600519', name: '贵州茅台' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    repo.save.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.create('u1', { code: '600519', name: '贵州茅台' })).rejects.toThrow(
      'database unavailable',
    );
  });
  it('删除必须带归属，不存在或他人的记录均返回404', async () => {
    repo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove('u2', 'w1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.delete).toHaveBeenCalledWith({ id: 'w1', userId: 'u2' });
  });
});
