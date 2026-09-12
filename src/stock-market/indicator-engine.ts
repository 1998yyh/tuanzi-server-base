import type { IndicatorRequest, IndicatorRow, MacdValue, MarketBar } from './market.types';

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export class IndicatorEngine {
  static calculate(bars: MarketBar[], request: IndicatorRequest): IndicatorRow[] {
    const rows: IndicatorRow[] = bars.map(() => ({ ma: {}, macd: {}, kdj: {}, rsi: {}, boll: {} }));
    const closes = bars.map((bar) => bar.close);

    for (const period of request.ma ?? []) {
      for (let i = 0; i < bars.length; i += 1)
        rows[i].ma[String(period)] =
          i + 1 < period ? null : mean(closes.slice(i + 1 - period, i + 1));
    }
    for (const config of request.boll ?? []) {
      const key = `${config.period}:${config.multiplier}`;
      for (let i = 0; i < bars.length; i += 1) {
        if (i + 1 < config.period) rows[i].boll[key] = null;
        else {
          const window = closes.slice(i + 1 - config.period, i + 1);
          const middle = mean(window);
          const deviation = Math.sqrt(mean(window.map((value) => (value - middle) ** 2)));
          rows[i].boll[key] = {
            middle,
            upper: middle + config.multiplier * deviation,
            lower: middle - config.multiplier * deviation,
          };
        }
      }
    }
    for (const config of request.macd ?? []) {
      const key = `${config.fast}:${config.slow}:${config.signal}`;
      const fast = this.ema(closes, config.fast);
      const slow = this.ema(closes, config.slow);
      const dif = closes.map((_, i) =>
        fast[i] == null || slow[i] == null ? null : fast[i]! - slow[i]!,
      );
      const firstDif = dif.findIndex((value) => value != null);
      let dea: number | null = null;
      for (let i = 0; i < closes.length; i += 1) {
        if (dif[i] == null || i < firstDif + config.signal - 1) rows[i].macd[key] = null;
        else {
          if (dea == null) dea = mean(dif.slice(firstDif, i + 1) as number[]);
          else dea += (dif[i]! - dea) * (2 / (config.signal + 1));
          rows[i].macd[key] = { dif: dif[i]!, dea, histogram: 2 * (dif[i]! - dea) };
        }
      }
    }
    for (const config of request.kdj ?? []) {
      const key = `${config.period}:${config.k}:${config.d}`;
      let k = 50;
      let d = 50;
      for (let i = 0; i < bars.length; i += 1) {
        if (i + 1 < config.period) rows[i].kdj[key] = null;
        else {
          const window = bars.slice(i + 1 - config.period, i + 1);
          const highest = Math.max(...window.map((bar) => bar.high));
          const lowest = Math.min(...window.map((bar) => bar.low));
          const rsv =
            highest === lowest ? 50 : ((bars[i].close - lowest) / (highest - lowest)) * 100;
          k = ((config.k - 1) * k + rsv) / config.k;
          d = ((config.d - 1) * d + k) / config.d;
          rows[i].kdj[key] = { k, d, j: 3 * k - 2 * d };
        }
      }
    }
    for (const period of request.rsi ?? []) {
      let averageGain = 0;
      let averageLoss = 0;
      for (let i = 0; i < bars.length; i += 1) {
        const key = String(period);
        if (i < period) rows[i].rsi[key] = null;
        else if (i === period) {
          const changes = closes.slice(1, period + 1).map((value, j) => value - closes[j]);
          averageGain = mean(changes.map((value) => Math.max(value, 0)));
          averageLoss = mean(changes.map((value) => Math.max(-value, 0)));
          rows[i].rsi[key] = this.rsi(averageGain, averageLoss);
        } else {
          const change = closes[i] - closes[i - 1];
          averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
          averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
          rows[i].rsi[key] = this.rsi(averageGain, averageLoss);
        }
      }
    }
    return rows;
  }

  private static rsi(gain: number, loss: number): number {
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  }

  private static ema(values: number[], period: number): Array<number | null> {
    const result: Array<number | null> = values.map(() => null);
    if (values.length < period) return result;
    let value = mean(values.slice(0, period));
    result[period - 1] = value;
    for (let i = period; i < values.length; i += 1) {
      value += (values[i] - value) * (2 / (period + 1));
      result[i] = value;
    }
    return result;
  }
}

export const isMacdValue = (value: MacdValue | null | undefined): value is MacdValue =>
  value != null;
