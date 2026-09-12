import {
  evaluateAlert,
  isFreshCompletedDayBar,
  isFreshQuote,
} from 'src/stock-alerts/alert-evaluator';

describe('股票提醒条件计算', () => {
  const now = new Date('2026-09-11T02:00:00.000Z'); // 上海周五 10:00

  it('价格首次已满足时触发一次，持续满足时不重复触发', () => {
    expect(
      evaluateAlert(
        { field: 'price', operator: 'gte', threshold: 10 },
        { value: 10, lastMatch: null },
      ),
    ).toEqual({ match: true, trigger: true });
    expect(
      evaluateAlert(
        { field: 'price', operator: 'gte', threshold: 10 },
        { value: 11, lastMatch: true },
      ),
    ).toEqual({ match: true, trigger: false });
  });

  it('条件退出后再次进入才重新触发', () => {
    expect(
      evaluateAlert(
        { field: 'change', operator: 'lte', threshold: -3 },
        { value: -1, lastMatch: true },
      ),
    ).toEqual({ match: false, trigger: false });
    expect(
      evaluateAlert(
        { field: 'change', operator: 'lte', threshold: -3 },
        { value: -4, lastMatch: false },
      ),
    ).toEqual({ match: true, trigger: true });
  });

  it('MACD gte 代表金叉、lte 代表死叉且忽略 threshold', () => {
    expect(
      evaluateAlert(
        { field: 'MACD', operator: 'gte', threshold: 999 },
        { previousValue: -0.1, currentValue: 0.2, lastMatch: null },
      ),
    ).toEqual({ match: true, trigger: true });
    expect(
      evaluateAlert(
        { field: 'MACD', operator: 'lte', threshold: -999 },
        { previousValue: 0.1, currentValue: -0.2, lastMatch: null },
      ),
    ).toEqual({ match: true, trigger: true });
  });

  it('交叉类指标不依赖 lastMatch，只由相邻完成 bar 决定', () => {
    expect(
      evaluateAlert(
        { field: 'MACD', operator: 'gte', threshold: 0 },
        { previousValue: -0.1, currentValue: 0.2, lastMatch: true },
      ),
    ).toEqual({ match: true, trigger: true });
    expect(
      evaluateAlert(
        { field: 'MA', operator: 'lte', threshold: 0 },
        { previousValue: 0.1, currentValue: -0.2, lastMatch: true },
      ),
    ).toEqual({ match: true, trigger: true });
  });

  it('非有限指标值视为 unknown', () => {
    expect(
      evaluateAlert(
        { field: 'MACD', operator: 'gte', threshold: 0 },
        { previousValue: Number.NaN, currentValue: 0.2, lastMatch: null },
      ),
    ).toBeNull();
    expect(
      evaluateAlert(
        { field: 'MACD', operator: 'gte', threshold: 0 },
        { previousValue: -0.1, currentValue: Number.POSITIVE_INFINITY, lastMatch: null },
      ),
    ).toBeNull();
  });

  it('周末、盘外或过期报价不新鲜', () => {
    expect(isFreshQuote('2026-09-11T01:59:00.000Z', now)).toBe(true);
    expect(isFreshQuote('2026-09-11T00:00:00.000Z', now)).toBe(false);
    expect(isFreshQuote('2026-09-12T02:00:00.000Z', new Date('2026-09-12T02:01:00.000Z'))).toBe(
      false,
    );
  });

  it('日线仅接受最近应完成交易日的已完成 bar', () => {
    expect(isFreshCompletedDayBar({ time: '2026-09-10', complete: true }, now)).toBe(true);
    expect(isFreshCompletedDayBar({ time: '2026-09-09', complete: true }, now)).toBe(false);
    expect(isFreshCompletedDayBar({ time: '2026-09-10', complete: false }, now)).toBe(false);
  });
});
