import { Test } from '@nestjs/testing';
import { ResearchEvidenceService } from 'src/stock-research/research-evidence.service';
import { StockMarketService } from 'src/stock-market/stock-market.service';
import { StockScreeningService } from 'src/stock-screening/stock-screening.service';
describe('复盘证据', () => {
  let service: ResearchEvidenceService;
  let market: any, screening: any;
  beforeEach(async () => {
    market = { getBars: jest.fn(), getIndexBars: jest.fn() };
    screening = { get: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        ResearchEvidenceService,
        { provide: StockMarketService, useValue: market },
        { provide: StockScreeningService, useValue: screening },
      ],
    }).compile();
    service = m.get(ResearchEvidenceService);
  });
  it('历史复盘排除未来K线，不带入未来计算的指标', async () => {
    market.getBars.mockResolvedValue({
      source: 'test',
      fetchedAt: '2026-09-12',
      items: [
        { time: '2026-09-10', open: 10, close: 11, high: 12, low: 9, volume: 100, complete: true },
        {
          time: '2026-09-11',
          open: 11,
          close: 99,
          high: 100,
          low: 10,
          volume: 1000,
          complete: true,
        },
      ],
      indicators: [{ future: true }],
    });
    const r: any = await service.snapshot('u1', {
      kind: 'stock',
      code: '600519',
      date: '2026-09-10',
    });
    expect(r.available).toBe(true);
    expect(r.bars).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('future');
    expect(r.asOf).toBe('2026-09-10');
  });
  it('行情失败记录明确缺失，不编造', async () => {
    market.getBars.mockRejectedValue(new Error('network'));
    const r = await service.snapshot('u1', { kind: 'stock', code: '600519', date: '2026-09-10' });
    expect(r.available).toBe(false);
    expect(r.reason).toBeDefined();
  });
  it('没有有效候选时不创建比较会话', async () => {
    screening.get.mockResolvedValue({ status: 'done', items: [], dataGaps: [] });
    await expect(service.snapshot('u1', { kind: 'screen', screeningRunId: 'r1' })).rejects.toThrow(
      '没有可比较',
    );
  });
  it('筛选快照按当前用户获取，不吞掉归属错误', async () => {
    screening.get.mockRejectedValue(new Error('not owned'));
    await expect(service.snapshot('u2', { kind: 'screen', screeningRunId: 'r1' })).rejects.toThrow(
      'not owned',
    );
    expect(screening.get).toHaveBeenCalledWith('u2', 'r1');
  });
  it('勾选必须来自该任务有效候选，按所选顺序保存', async () => {
    screening.get.mockResolvedValue({
      status: 'done',
      items: [
        { code: '600519', match: true },
        { code: '000001', match: true },
      ],
      dataGaps: [],
    });
    const snapshot: any = await service.snapshot('u1', {
      kind: 'screen',
      screeningRunId: 'r1',
      codes: ['000001'],
    });
    expect(snapshot.run.items.map((x: any) => x.code)).toEqual(['000001']);
    await expect(
      service.snapshot('u1', { kind: 'screen', screeningRunId: 'r1', codes: ['999999'] }),
    ).rejects.toThrow('所选股票');
  });
  it('只分析有效命中候选，限制上下文大小并明确未纳入数量', async () => {
    screening.get.mockResolvedValue({
      id: 'r1',
      status: 'done',
      strategySnapshot: { conditions: [{ indicator: 'MA' }] },
      total: 5000,
      checked: 5000,
      matched: 35,
      targetSnapshot: Array(5000).fill({ code: '600000' }),
      items: [
        ...Array.from({ length: 35 }, (_, n) => ({ code: String(600000 + n), match: true })),
        { code: '999999', match: true, dataGap: '陈旧' },
        { code: '888888', match: false },
      ],
      dataGaps: [{ code: '999999', reason: '陈旧' }],
    });
    const evidence: any = await service.snapshot('u1', { kind: 'screen', screeningRunId: 'r1' });
    expect(evidence.run.items).toHaveLength(30);
    expect(evidence.selection).toEqual(
      expect.objectContaining({ eligible: 35, included: 30, omitted: 5 }),
    );
    expect(evidence.run.targetSnapshot).toBeUndefined();
    expect(JSON.stringify(evidence.run.items)).not.toContain('999999');
    expect(evidence.run.strategySnapshot.conditions[0].indicator).toBe('MA');
  });
});
