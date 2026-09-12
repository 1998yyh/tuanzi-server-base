import { StrategyEvaluator } from '../../src/stock-screening/strategy-evaluator';

describe('StrategyEvaluator', () => {
  it('MACD 只在前一根有效柱未站上且当前站上时命中', () => {
    expect(
      StrategyEvaluator.macdCross(
        { dif: 2, dea: 1, histogram: 2 },
        { dif: 1, dea: 1, histogram: 0 },
      ),
    ).toBe(true);
    expect(
      StrategyEvaluator.macdCross(
        { dif: 2, dea: 1, histogram: 2 },
        { dif: 2, dea: 1, histogram: 2 },
      ),
    ).toBe(false);
    expect(StrategyEvaluator.macdCross({ dif: 2, dea: 1, histogram: 2 }, null)).toBe(false);
  });
});
