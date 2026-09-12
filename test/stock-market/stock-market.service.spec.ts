import { StockMarketService } from '../../src/stock-market/stock-market.service';

describe('StockMarketService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('报价 asOf 使用上游 f124 时间而不是抓取时间', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          diff: [
            { f12: '600519', f14: '贵州茅台', f2: 1500, f3: 1.2, f4: 18, f124: 1_700_000_000 },
          ],
        },
      }),
    } as Response);
    const result = await new StockMarketService().getQuotes(['600519']);
    expect(result.items[0].asOf).toBe('2023-11-14T22:13:20.000Z');
    expect(result.fetchedAt).not.toBe(result.items[0].asOf);
  });

  it('周六保留刚结束交易周的周 K', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-12T04:00:00Z'));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: { klines: ['2026-09-11,10,11,12,9,100'] } }),
    } as Response);
    await expect(new StockMarketService().getBars('600519', 'week', 'none')).resolves.toMatchObject(
      { items: [{ time: '2026-09-11' }] },
    );
    jest.useRealTimers();
  });

  it('周日保留刚结束交易周的周 K', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-13T04:00:00Z'));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: { klines: ['2026-09-11,10,11,12,9,100'] } }),
    } as Response);
    await expect(new StockMarketService().getBars('600519', 'week', 'none')).resolves.toMatchObject(
      { items: [{ time: '2026-09-11' }] },
    );
    jest.useRealTimers();
  });

  it('指数响应乱序时按市场和代码识别', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          diff: [
            { f12: '399006', f13: 0, f14: '创业板指', f2: 3, f3: 0, f4: 0, f124: 1700000000 },
            { f12: '000001', f13: 1, f14: '上证指数', f2: 1, f3: 0, f4: 0, f124: 1700000000 },
            { f12: '399001', f13: 0, f14: '深证成指', f2: 2, f3: 0, f4: 0, f124: 1700000000 },
          ],
        },
      }),
    } as Response);
    const result = await new StockMarketService().getIndices();
    expect(result.items.map((item) => [item.code, item.price])).toEqual([
      ['sh000001', 1],
      ['sz399001', 2],
      ['sz399006', 3],
    ]);
  });

  it('识别 920 前缀为北交所并限制缓存容量', async () => {
    const service = new StockMarketService() as any;
    expect(service.market('920001')).toBe('bj');
    for (let i = 0; i < 1005; i += 1) await service.cached(`test:${i}`, 60_000, async () => i);
    expect(service.cache.size).toBeLessThanOrEqual(1000);
  });

  it('上游 K 线乱序或重复时显式失败', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { klines: ['2026-09-10,10,11,12,9,100', '2026-09-10,10,11,12,9,100'] },
      }),
    } as Response);
    await expect(new StockMarketService().getBars('600519', 'day', 'none')).rejects.toThrow(
      'K 线顺序或内容无效',
    );
  });

  it('分钟线拒绝复权参数', async () => {
    await expect(new StockMarketService().getBars('600519', 'minute', 'qfq')).rejects.toThrow(
      '分钟线仅支持 none',
    );
  });

  it('东方财富日线失败后使用腾讯前复权并标记真实来源', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: { sh600519: { qfqday: [['2026-09-11', '10', '11', '12', '9', '100']] } },
        }),
      } as Response);
    const result = await new StockMarketService().getBars('600519', 'day', 'qfq');
    expect(result).toMatchObject({ source: 'tencent', adjustment: 'qfq', items: [{ close: 11 }] });
  });

  it('分钟线使用 trends2 的真实不复权字段并标记来源', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: { trends: ['2026-09-10 09:30,0,10,11,9,100,0,10'] } }),
    } as Response);
    const result = await new StockMarketService().getBars('600519', 'minute', 'none', 1);
    expect(result).toMatchObject({
      source: 'eastmoney-trends',
      adjustment: 'none',
      items: [{ open: 0, close: 10 }],
    });
  });

  it('北交所主源失败时明确拒绝未验证的腾讯兜底', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('socket closed'));
    await expect(new StockMarketService().getBars('920001', 'day', 'none')).rejects.toThrow(
      '腾讯备用源未验证支持北交所',
    );
  });
});
