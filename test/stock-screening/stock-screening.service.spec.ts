import {
  screeningMatch,
  StockScreeningService,
} from '../../src/stock-screening/stock-screening.service';
import { ScreeningRunStatus } from '../../src/stock-screening/screening-run.entity';
import type { MarketBar } from '../../src/stock-market/market.types';

type ScreeningInternals = {
  requiredBars(value: unknown): number;
  isStale(lastTime: string, asOf: Date, period: 'day' | 'week'): boolean;
  execute(id: string): Promise<void>;
};

const internals = (service: StockScreeningService) => service as unknown as ScreeningInternals;

const shiftDate = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const barsEnding = (last: string, count: number, stepDays: number): MarketBar[] =>
  Array.from({ length: count }, (_, index) => {
    const time = shiftDate(last, (index - count + 1) * stepDays);
    const close = index === count - 1 ? 20 : 10;
    return { time, open: close, high: close, low: close, close, volume: 100, complete: true };
  });

describe('StockScreeningService', () => {
  it('创建任务时固定 ResearchWatch 目标和策略快照', async () => {
    const definition = {
      period: 'day',
      adjustment: 'qfq',
      scope: 'watchlist',
      match: 'all',
      conditions: [{ indicator: 'MA', parameters: [20] }],
    } as const;
    const runRepo = {
      create: jest.fn((value) => ({ id: 'run-1', ...value })),
      save: jest.fn(async (value) => value),
    };
    const watchRepo = { find: jest.fn().mockResolvedValue([{ code: '300750', name: '宁德时代' }]) };
    const strategies = { get: jest.fn().mockResolvedValue({ definition }) };
    const service = new StockScreeningService(
      runRepo as never,
      watchRepo as never,
      strategies as never,
      {} as never,
    );
    (service as any).execute = jest.fn().mockResolvedValue(undefined);

    const view = await service.create('user-1', { strategyId: 'custom-id' });

    expect(runRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        strategySnapshot: definition,
        targetSnapshot: [{ code: '300750', name: '宁德时代' }],
        catalogCoverage: '当前用户观察池快照',
        status: ScreeningRunStatus.QUEUED,
      }),
    );
    expect(view).toMatchObject({
      strategySnapshot: definition,
      targetSnapshot: [{ code: '300750', name: '宁德时代' }],
    });
  });

  it('MACD 最大合法参数请求至少 1000 根 K 线', () => {
    const service = new StockScreeningService({} as never, {} as never, {} as never, {} as never);
    expect(
      internals(service).requiredBars({
        period: 'day',
        adjustment: 'qfq',
        scope: 'all',
        match: 'all',
        conditions: [{ indicator: 'MACD', parameters: [12, 500, 500] }],
      }),
    ).toBe(1000);
  });

  it('陈旧或缺口数据即使条件命中也不得入选', () => {
    expect(screeningMatch(true, '末根 K 线陈旧')).toBe(false);
    expect(screeningMatch(true, undefined)).toBe(true);
  });

  it('周策略按自然周判断陈旧，周一或周五标注的当周柱都可用', () => {
    const service = new StockScreeningService({} as never, {} as never, {} as never, {} as never);
    const isStale = internals(service).isStale.bind(service);
    const saturday = new Date('2026-09-12T04:00:00.000Z');
    const wednesday = new Date('2026-09-09T02:00:00.000Z');
    expect(isStale('2026-09-11', saturday, 'week')).toBe(false);
    expect(isStale('2026-09-07', saturday, 'week')).toBe(false);
    expect(isStale('2026-09-04', saturday, 'week')).toBe(true);
    expect(isStale('2026-08-31', saturday, 'week')).toBe(true);
    expect(isStale('2026-09-04', wednesday, 'week')).toBe(false);
    expect(isStale('2026-08-31', wednesday, 'week')).toBe(false);
    expect(isStale('2026-08-28', wednesday, 'week')).toBe(true);
  });

  it('日策略陈旧判断仍按上一交易日', () => {
    const service = new StockScreeningService({} as never, {} as never, {} as never, {} as never);
    const isStale = internals(service).isStale.bind(service);
    expect(isStale('2026-09-11', new Date('2026-09-12T04:00:00.000Z'), 'day')).toBe(false);
    expect(isStale('2026-09-10', new Date('2026-09-12T04:00:00.000Z'), 'day')).toBe(true);
  });

  it('周筛选同时接受东财周五标注和腾讯周一标注的当周 K 线', async () => {
    const definition = {
      period: 'week' as const,
      adjustment: 'qfq' as const,
      scope: 'watchlist' as const,
      match: 'all' as const,
      conditions: [{ indicator: 'MA' as const, parameters: [20] }],
    };
    const fridayBars = barsEnding('2026-09-11', 60, 7);
    const mondayBars = barsEnding('2026-09-07', 60, 7);
    const updates: Array<{ where: unknown; value: Record<string, unknown> }> = [];
    const runRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'run-1',
        status: ScreeningRunStatus.QUEUED,
        asOf: new Date('2026-09-12T04:00:00.000Z'),
        strategySnapshot: definition,
        targetSnapshot: [
          { code: '600519', name: '贵州茅台' },
          { code: '300750', name: '宁德时代' },
        ],
      }),
      update: jest.fn(async (where: unknown, value: Record<string, unknown>) => {
        updates.push({ where, value });
        return { affected: 1 };
      }),
    };
    const market = {
      getIndexBars: jest.fn().mockResolvedValue({ items: fridayBars }),
      getBars: jest.fn(async (code: string) => ({
        items: code === '600519' ? fridayBars : mondayBars,
        source: code === '600519' ? 'eastmoney' : 'tencent',
        fetchedAt: '2026-09-12T04:00:00.000Z',
      })),
    };
    const service = new StockScreeningService(
      runRepo as never,
      {} as never,
      {} as never,
      market as never,
    );

    await internals(service).execute('run-1');

    const done = updates.find((item) => item.value.status === ScreeningRunStatus.DONE);
    expect(done?.value).toMatchObject({ matched: 2 });
    expect(done?.value.items).toEqual([
      expect.objectContaining({ code: '600519', match: true, barTime: '2026-09-11' }),
      expect.objectContaining({ code: '300750', match: true, barTime: '2026-09-07' }),
    ]);
    expect(done?.value.dataGaps).toEqual([]);
  });
});
