import { BadRequestException } from '@nestjs/common';
import { listTemplates, validateDefinition } from 'src/stock-strategies/strategy-definition';
const valid = () => ({
  period: 'day',
  adjustment: 'qfq',
  scope: 'watchlist',
  match: 'all',
  conditions: [
    { indicator: 'MACD', parameters: [12, 26, 9] },
    { indicator: 'KDJ', parameters: [9, 3, 3], threshold: 50 },
  ],
});
describe('指标策略定义', () => {
  it('保留组合关系和参数', () => expect(validateDefinition(valid())).toEqual(valid()));
  it.each([
    { conditions: [] },
    { conditions: [{ indicator: 'FORMULA', parameters: [20] }] },
    { conditions: [{ indicator: 'MACD', parameters: [26, 12, 9] }] },
    { conditions: [{ indicator: 'MACD', parameters: [12, 26] }] },
    { conditions: [{ indicator: 'MA', parameters: [2.5] }] },
    { conditions: [{ indicator: 'KDJ', parameters: [9, 3, 3], threshold: 101 }] },
    { conditions: [{ indicator: 'RSI', parameters: [6], threshold: null }] },
    { period: 'minute' },
    { formula: 'eval()' },
    { userId: 'other' },
  ])('拒绝无效定义 %j', (patch) =>
    expect(() => validateDefinition({ ...valid(), ...patch })).toThrow(BadRequestException),
  );
  it('五个固定模板都能通过校验且调用者不能改写模板', () => {
    const templates = listTemplates();
    expect(templates).toHaveLength(5);
    templates.forEach((t) => expect(validateDefinition(t.definition)).toEqual(t.definition));
    templates[0].definition.conditions[0].parameters[0] = 999;
    expect(listTemplates()[0].definition.conditions[0].parameters[0]).toBe(12);
  });
});
