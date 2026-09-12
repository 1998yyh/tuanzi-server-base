import { IndicatorEngine } from '../../src/stock-market/indicator-engine';

const bars = (closes: number[]) =>
  closes.map((close, index) => ({
    time: `2026-01-${String(index + 1).padStart(2, '0')}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    complete: true,
  }));

describe('IndicatorEngine', () => {
  it('MA 和 BOLL 在预热期返回 null，并使用总体标准差', () => {
    const result = IndicatorEngine.calculate(bars([1, 2, 3]), {
      ma: [3],
      boll: [{ period: 3, multiplier: 2 }],
    });
    expect(result[1].ma['3']).toBeNull();
    expect(result[2].ma['3']).toBe(2);
    expect(result[2].boll['3:2']).toEqual({
      middle: 2,
      upper: 2 + 2 * Math.sqrt(2 / 3),
      lower: 2 - 2 * Math.sqrt(2 / 3),
    });
  });

  it('RSI 使用 Wilder 平滑并正确处理全涨窗口', () => {
    const result = IndicatorEngine.calculate(bars([1, 2, 3, 4]), { rsi: [3] });
    expect(result[2].rsi['3']).toBeNull();
    expect(result[3].rsi['3']).toBe(100);
  });

  it('KDJ 分母为零时沿用中性 RSV，并从 K/D=50 平滑', () => {
    const flat = [1, 1, 1].map((close, index) => ({
      ...bars([close])[0],
      time: `2026-01-0${index + 1}`,
      high: 1,
      low: 1,
    }));
    const result = IndicatorEngine.calculate(flat, { kdj: [{ period: 3, k: 3, d: 3 }] });
    expect(result[2].kdj['3:3:3']).toEqual({ k: 50, d: 50, j: 50 });
  });

  it('MACD 快慢 EMA 以各自 SMA 初始化，DEA 以 signal 个 DIF 的 SMA 初始化', () => {
    const result = IndicatorEngine.calculate(bars([1, 2, 3, 4]), {
      macd: [{ fast: 2, slow: 3, signal: 2 }],
    });
    expect(result[2].macd['2:3:2']).toBeNull();
    expect(result[3].macd['2:3:2']).toEqual({ dif: 0.5, dea: 0.5, histogram: 0 });
  });
});
