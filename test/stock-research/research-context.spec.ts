import { BadRequestException } from '@nestjs/common';
import { contextPrompt, validateContext } from 'src/stock-research/research-context';
describe('复盘上下文', () => {
  it('筛选对话接受最多30个勾选代码，拒绝重复或超限', () => {
    const context = {
      kind: 'screen',
      screeningRunId: '00000000-0000-4000-8000-000000000001',
      codes: ['600519'],
    };
    expect(validateContext(context)).toEqual(context);
    expect(() => validateContext({ ...context, codes: ['600519', '600519'] })).toThrow(
      BadRequestException,
    );
    expect(() =>
      validateContext({
        ...context,
        codes: Array.from({ length: 31 }, (_, n) => String(600000 + n)),
      }),
    ).toThrow(BadRequestException);
  });
  it('接受有股票和有效日期的个股复盘', () =>
    expect(validateContext({ kind: 'stock', code: '600519', date: '2026-09-10' })).toEqual({
      kind: 'stock',
      code: '600519',
      date: '2026-09-10',
    }));
  it.each([
    { kind: 'market', date: '2999-01-01' },
    { kind: 'stock' },
    { kind: 'market', date: '2026-02-30' },
    { kind: 'market', date: '2026-09-31' },
    { kind: 'screen' },
    { kind: 'general', code: '600519' },
    { kind: 'stock', code: '600519', date: '2026-09-10', source: 'trusted' },
    { kind: 'stock', code: '123', date: '2026-09-10' },
  ])('拒绝不完整或伪造上下文 %j', (v) =>
    expect(() => validateContext(v)).toThrow(BadRequestException),
  );
  it('上下文提示明确缺失数据并把事实与用户输入分开', () => {
    const text = contextPrompt(
      { kind: 'stock', code: '600519', date: '2026-09-10' },
      { available: false, reason: '未接入' },
    );
    expect(text).toContain('未接入');
    expect(text).toContain('600519');
    expect(text).toContain('不编造');
    expect(text).toContain('数据');
  });
});
