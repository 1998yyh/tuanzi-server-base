import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
const period = z.number().int().min(1).max(500);
const threshold = z.number().min(0).max(100);
const condition = z.discriminatedUnion('indicator', [
  z.object({ indicator: z.literal('MA'), parameters: z.tuple([period]) }).strict(),
  z
    .object({ indicator: z.literal('MACD'), parameters: z.tuple([period, period, period]) })
    .strict(),
  z
    .object({
      indicator: z.literal('KDJ'),
      parameters: z.tuple([period, period, period]),
      threshold,
    })
    .strict(),
  z.object({ indicator: z.literal('RSI'), parameters: z.tuple([period]), threshold }).strict(),
  z
    .object({
      indicator: z.literal('BOLL'),
      parameters: z.tuple([period, z.number().positive().max(10)]),
    })
    .strict(),
]);
const schema = z
  .object({
    period: z.enum(['day', 'week']),
    adjustment: z.enum(['none', 'qfq', 'hfq']),
    scope: z.enum(['watchlist', 'all']),
    match: z.enum(['all', 'any']),
    conditions: z.array(condition).min(1).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.conditions.forEach((c, i) => {
      if (c.indicator === 'MACD' && c.parameters[0] >= c.parameters[1]) {
        ctx.addIssue({
          code: 'custom',
          path: ['conditions', i, 'parameters'],
          message: 'MACD 快线周期必须小于慢线周期',
        });
      }
    });
  });
export type StrategyDefinition = z.infer<typeof schema>;
export function validateDefinition(value: unknown): StrategyDefinition {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException('策略定义无效：请检查指标、参数数量、取值范围及 MACD 快慢周期');
  return result.data;
}
export function listTemplates() {
  const examples: {
    id: string;
    name: string;
    condition: StrategyDefinition['conditions'][number];
  }[] = [
    {
      id: 'macd-cross',
      name: 'MACD 金叉',
      condition: { indicator: 'MACD', parameters: [12, 26, 9] },
    },
    {
      id: 'kdj-low',
      name: 'KDJ 低位观察',
      condition: { indicator: 'KDJ', parameters: [9, 3, 3], threshold: 50 },
    },
    { id: 'ma-above', name: '站上 MA20', condition: { indicator: 'MA', parameters: [20] } },
    {
      id: 'rsi-below',
      name: 'RSI 强弱观察',
      condition: { indicator: 'RSI', parameters: [6], threshold: 70 },
    },
    {
      id: 'boll-above',
      name: 'BOLL 中轨上方',
      condition: { indicator: 'BOLL', parameters: [20, 2] },
    },
  ];
  return examples.map(({ id, name, condition }) => ({
    id,
    name,
    version: 1,
    readonly: true,
    definition: validateDefinition({
      period: 'day',
      adjustment: 'qfq',
      scope: 'watchlist',
      match: 'all',
      conditions: [condition],
    }),
  }));
}
