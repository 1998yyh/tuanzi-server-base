import type { StrategyDefinition } from '../stock-strategies/strategy-definition';
import { IndicatorEngine } from '../stock-market/indicator-engine';
import type {
  IndicatorRequest,
  IndicatorRow,
  MacdValue,
  MarketBar,
} from '../stock-market/market.types';

export class StrategyEvaluator {
  static indicators(definition: StrategyDefinition): IndicatorRequest {
    const request: IndicatorRequest = { ma: [], macd: [], kdj: [], rsi: [], boll: [] };
    for (const condition of definition.conditions) {
      if (condition.indicator === 'MA') request.ma!.push(condition.parameters[0]);
      if (condition.indicator === 'MACD')
        request.macd!.push({
          fast: condition.parameters[0],
          slow: condition.parameters[1],
          signal: condition.parameters[2],
        });
      if (condition.indicator === 'KDJ')
        request.kdj!.push({
          period: condition.parameters[0],
          k: condition.parameters[1],
          d: condition.parameters[2],
        });
      if (condition.indicator === 'RSI') request.rsi!.push(condition.parameters[0]);
      if (condition.indicator === 'BOLL')
        request.boll!.push({
          period: condition.parameters[0],
          multiplier: condition.parameters[1],
        });
    }
    return request;
  }

  static evaluate(
    bars: MarketBar[],
    definition: StrategyDefinition,
  ): { match: boolean; conditions: boolean[]; indicators: IndicatorRow | null; complete: boolean } {
    if (bars.length === 0)
      return { match: false, conditions: [], indicators: null, complete: false };
    const rows = IndicatorEngine.calculate(bars, this.indicators(definition));
    const current = rows.at(-1)!;
    const previous = rows.at(-2) ?? null;
    const close = bars.at(-1)!.close;
    let complete = true;
    const conditions = definition.conditions.map((condition) => {
      if (condition.indicator === 'MA') {
        const value = current.ma[String(condition.parameters[0])];
        if (value == null) complete = false;
        return value != null && close > value;
      }
      if (condition.indicator === 'MACD') {
        const key = condition.parameters.join(':');
        const prior = previous?.macd[key];
        if (current.macd[key] == null || prior == null) complete = false;
        return this.macdCross(current.macd[key], prior);
      }
      if (condition.indicator === 'KDJ') {
        const value = current.kdj[condition.parameters.join(':')];
        if (value == null) complete = false;
        return value != null && value.k < condition.threshold;
      }
      if (condition.indicator === 'RSI') {
        const value = current.rsi[String(condition.parameters[0])];
        if (value == null) complete = false;
        return value != null && value < condition.threshold;
      }
      const value = current.boll[condition.parameters.join(':')];
      if (value == null) complete = false;
      return value != null && close > value.middle;
    });
    return {
      match:
        complete &&
        (definition.match === 'all' ? conditions.every(Boolean) : conditions.some(Boolean)),
      conditions,
      indicators: current,
      complete,
    };
  }

  static macdCross(
    current: MacdValue | null | undefined,
    previous: MacdValue | null | undefined,
  ): boolean {
    return (
      current != null &&
      previous != null &&
      current.dif > current.dea &&
      previous.dif <= previous.dea
    );
  }
}
