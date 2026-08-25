import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { WatchlistService } from 'src/stock-signals/watchlist.service';
import { StockWatchlist, WatchlistStatus } from 'src/stock-signals/entities/watchlist.entity';
import { StockSignal } from 'src/stock-signals/entities/stock-signal.entity';
import { StockSignalsService } from 'src/stock-signals/stock-signals.service';

describe('WatchlistService', () => {
  let service: WatchlistService;
  let watchRepo: Record<string, jest.Mock>;
  let signalRepo: Record<string, jest.Mock>;
  let signalsService: Record<string, jest.Mock>;

  const makeRow = (over: Partial<StockWatchlist> = {}): StockWatchlist => ({
    id: 'w-1',
    userId: 'user-1',
    code: '600519',
    market: 'sh',
    name: '贵州茅台',
    status: WatchlistStatus.WATCHING,
    entrySignalDate: '2026-08-20',
    triggeredSignalDate: null,
    createdAt: new Date('2026-08-21T01:00:00Z'),
    updatedAt: new Date('2026-08-21T01:00:00Z'),
    ...over,
  });

  beforeEach(async () => {
    watchRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => v),
      update: jest.fn(),
      remove: jest.fn(),
    };
    signalRepo = { findOne: jest.fn() };
    signalsService = {
      chinaToday: jest.fn().mockReturnValue('2026-08-25'),
      refreshCodes: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WatchlistService,
        { provide: getRepositoryToken(StockWatchlist), useValue: watchRepo },
        { provide: getRepositoryToken(StockSignal), useValue: signalRepo },
        { provide: StockSignalsService, useValue: signalsService },
      ],
    }).compile();

    service = module.get(WatchlistService);
  });

  describe('evaluateWatching（S 评估共享规则）', () => {
    it('存在晚于入池日的 S 信号（value=0）→ 置 triggered，日期取满足条件的最大日期', async () => {
      signalRepo.findOne.mockResolvedValue({
        code: '600519',
        value: '0',
        signalDate: '2026-08-24',
      });

      const triggered = await service.evaluateWatching([makeRow()]);

      expect(triggered).toBe(1);
      // 查询条件：同 code、value='0'、signal_date 严格晚于入池依据日，按日期倒序取第一行（即最大日期）
      expect(signalRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ code: '600519', value: '0' }),
          order: { signalDate: 'DESC' },
        }),
      );
      expect(watchRepo.update).toHaveBeenCalledWith('w-1', {
        status: WatchlistStatus.TRIGGERED,
        triggeredSignalDate: '2026-08-24',
      });
    });

    it('入池依据日通过 MoreThan 传入查询（严格大于，等于入池日的 S 不算）', async () => {
      signalRepo.findOne.mockResolvedValue(null);
      await service.evaluateWatching([makeRow({ entrySignalDate: '2026-08-22' })]);
      const where = signalRepo.findOne.mock.calls[0][0].where;
      // FindOperator：type=moreThan、value=入池依据日（即 signal_date > 该日，等于不算）
      expect(where.signalDate.type).toBe('moreThan');
      expect(where.signalDate.value).toBe('2026-08-22');
      expect(triggeredCount(watchRepo)).toBe(0);
    });

    it('无 S 信号（只有 B 或空值）→ 不触发', async () => {
      signalRepo.findOne.mockResolvedValue(null);
      const triggered = await service.evaluateWatching([makeRow(), makeRow({ id: 'w-2' })]);
      expect(triggered).toBe(0);
      expect(watchRepo.update).not.toHaveBeenCalled();
    });

    it('已 triggered 的行被防御性跳过', async () => {
      const triggered = await service.evaluateWatching([
        makeRow({ status: WatchlistStatus.TRIGGERED }),
      ]);
      expect(triggered).toBe(0);
      expect(signalRepo.findOne).not.toHaveBeenCalled();
    });

    it('不传 rows 时（cron 用）查全站 watching 行逐条评估', async () => {
      watchRepo.find.mockResolvedValue([makeRow(), makeRow({ id: 'w-2', code: '000001' })]);
      signalRepo.findOne
        .mockResolvedValueOnce({ code: '600519', value: '0', signalDate: '2026-08-24' })
        .mockResolvedValueOnce(null);

      const triggered = await service.evaluateWatching();

      expect(watchRepo.find).toHaveBeenCalledWith({
        where: { status: WatchlistStatus.WATCHING },
      });
      expect(signalRepo.findOne).toHaveBeenCalledTimes(2);
      expect(triggered).toBe(1);
      expect(watchRepo.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('addItems（批量入池）', () => {
    it('非法代码与非法日期进 invalid，正常项落库；market 缺省推断、name 缺省取清单', async () => {
      signalRepo.findOne.mockResolvedValue(null);

      const res = await service.addItems('user-1', [
        { code: '600519', entrySignalDate: '2026-08-20' },
        { code: '000001', market: 'sz', name: '平安银行', entrySignalDate: '2026-08-20' },
        { code: '300750', entrySignalDate: '2026-08-20' }, // 创业板，非法
        { code: 'abc', entrySignalDate: '2026-08-20' },
        { code: '600000', entrySignalDate: '2026-02-30' }, // 日历不存在的日期
      ]);

      expect(res.invalid).toEqual(['300750', 'abc', '600000']);
      expect(res.added).toEqual(['600519', '000001']);
      const inserted = watchRepo.create.mock.calls[0][0];
      expect(inserted).toEqual([
        // 6 开头缺省 sh；name 缺省取内置清单
        expect.objectContaining({ code: '600519', market: 'sh', name: '贵州茅台' }),
        expect.objectContaining({ code: '000001', market: 'sz', name: '平安银行' }),
      ]);
      expect(res.items).toBeDefined();
    });

    it('已在池中的与批内重复的都进 duplicated，不重复落库', async () => {
      watchRepo.find.mockResolvedValue([makeRow()]); // 池中已有 600519
      signalRepo.findOne.mockResolvedValue(null);

      const res = await service.addItems('user-1', [
        { code: '600519', entrySignalDate: '2026-08-20' }, // 池中已有
        { code: '000001', entrySignalDate: '2026-08-20' },
        { code: '000001', entrySignalDate: '2026-08-20' }, // 批内重复
      ]);

      expect(res.duplicated).toEqual(['600519', '000001']);
      expect(res.added).toEqual(['000001']);
      expect(watchRepo.create.mock.calls[0][0]).toHaveLength(1);
    });

    it('池子上限 100：填满为止，其余进 overflow', async () => {
      watchRepo.find.mockResolvedValue(
        Array.from({ length: 99 }, (_, i) =>
          makeRow({ id: `w-${i}`, code: `6000${String(i).padStart(2, '0')}` }),
        ),
      );
      signalRepo.findOne.mockResolvedValue(null);

      const res = await service.addItems('user-1', [
        { code: '600519', entrySignalDate: '2026-08-20' },
        { code: '000001', entrySignalDate: '2026-08-20' },
      ]);

      expect(res.added).toEqual(['600519']);
      expect(res.overflow).toEqual(['000001']);
      expect(watchRepo.create.mock.calls[0][0]).toHaveLength(1);
    });

    it('入池即时 S 判定：历史已有晚于入池日的 S 信号 → 新行直接 triggered', async () => {
      signalRepo.findOne.mockResolvedValue({
        code: '600519',
        value: '0',
        signalDate: '2026-08-22',
      });
      const newRow = makeRow({ id: 'w-new' });
      watchRepo.save.mockResolvedValue([newRow]);

      const res = await service.addItems('user-1', [
        { code: '600519', entrySignalDate: '2026-08-20' },
      ]);

      expect(res.added).toEqual(['600519']);
      expect(watchRepo.update).toHaveBeenCalledWith('w-new', {
        status: WatchlistStatus.TRIGGERED,
        triggeredSignalDate: '2026-08-22',
      });
    });
  });

  describe('remove（删除）', () => {
    it('删自己的条目成功', async () => {
      const row = makeRow();
      watchRepo.findOne.mockResolvedValue(row);
      await service.remove('user-1', 'w-1');
      expect(watchRepo.remove).toHaveBeenCalledWith(row);
    });

    it('他人的条目按 404 处理（不泄露存在性）', async () => {
      watchRepo.findOne.mockResolvedValue(makeRow({ userId: 'user-2' }));
      await expect(service.remove('user-1', 'w-1')).rejects.toThrow(NotFoundException);
      expect(watchRepo.remove).not.toHaveBeenCalled();
    });

    it('不存在的条目 404', async () => {
      watchRepo.findOne.mockResolvedValue(null);
      await expect(service.remove('user-1', 'w-x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('check（手动立即检查）', () => {
    it('空池子短路：不刷新不评估', async () => {
      watchRepo.find.mockResolvedValue([]);
      const res = await service.check('user-1');
      expect(res).toEqual({ checked: 0, triggered: 0, items: [] });
      expect(signalsService.refreshCodes).not.toHaveBeenCalled();
      expect(signalRepo.findOne).not.toHaveBeenCalled();
    });

    it('非空池子：全部代码强制刷新当日信号，再对 watching 项评估', async () => {
      const rows = [
        makeRow(),
        makeRow({ id: 'w-2', code: '000001', market: 'sz', status: WatchlistStatus.TRIGGERED }),
      ];
      watchRepo.find.mockResolvedValue(rows);
      signalRepo.findOne.mockResolvedValue({
        code: '600519',
        value: '0',
        signalDate: '2026-08-25',
      });

      const res = await service.check('user-1');

      // list 排序 triggered 排前，故 w-2（triggered）在 w-1（watching）之前
      expect(signalsService.refreshCodes).toHaveBeenCalledWith('2026-08-25', [
        'sz000001',
        'sh600519',
      ]);
      // triggered 行不参与评估（只对 watching 项查信号）
      expect(signalRepo.findOne).toHaveBeenCalledTimes(1);
      expect(res.checked).toBe(2);
      expect(res.triggered).toBe(1);
    });
  });

  describe('list（排序）', () => {
    it('triggered 排前，其余按创建时间倒序', async () => {
      watchRepo.find.mockResolvedValue([
        makeRow({ id: 'w-old', createdAt: new Date('2026-08-20T01:00:00Z') }),
        makeRow({
          id: 'w-trig',
          status: WatchlistStatus.TRIGGERED,
          createdAt: new Date('2026-08-19T01:00:00Z'),
        }),
        makeRow({ id: 'w-new', createdAt: new Date('2026-08-21T01:00:00Z') }),
      ]);
      const items = await service.list('user-1');
      expect(items.map((r) => r.id)).toEqual(['w-trig', 'w-new', 'w-old']);
    });
  });
});

/** 统计 update 被置为 triggered 的调用次数 */
function triggeredCount(watchRepo: Record<string, jest.Mock>): number {
  return watchRepo.update.mock.calls.filter((c) => c[1]?.status === WatchlistStatus.TRIGGERED)
    .length;
}
