import { BadRequestException, Injectable } from '@nestjs/common';
import { ResearchContext } from './research-context';
import { StockMarketService } from '../stock-market/stock-market.service';
import { StockScreeningService } from '../stock-screening/stock-screening.service';
import { IndicatorEngine } from '../stock-market/indicator-engine';
import { MarketBar } from '../stock-market/market.types';
@Injectable()
export class ResearchEvidenceService {
  constructor(
    private readonly market: StockMarketService,
    private readonly screening: StockScreeningService,
  ) {}
  async snapshot(userId: string, context: ResearchContext): Promise<Record<string, unknown>> {
    if (context.kind === 'general')
      return {
        available: false,
        reason: '自由对话尚未指定行情上下文；没有默认实时行情',
        capturedAt: new Date().toISOString(),
      };
    if (context.kind === 'screen') {
      const run = await this.screening.get(userId, context.screeningRunId);
      if (run.status !== 'done')
        throw new BadRequestException('筛选任务尚未完成，请完成后再发起比较');
      const eligible = run.items.filter((item) => item.match && !item.dataGap);
      if (!eligible.length) throw new BadRequestException('该筛选任务没有可比较的有效候选');
      const byCode = new Map(eligible.map((item) => [item.code, item]));
      if (context.codes?.some((code) => !byCode.has(code)))
        throw new BadRequestException('所选股票必须属于该筛选任务的有效命中候选');
      const included = context.codes
        ? context.codes.map((code) => byCode.get(code)!)
        : eligible.slice(0, 30);
      return {
        available: true,
        kind: 'screen',
        run: {
          id: run.id,
          strategyId: run.strategyId,
          strategySnapshot: run.strategySnapshot,
          asOf: run.asOf,
          sampledAt: run.sampledAt,
          total: run.total,
          checked: run.checked,
          matched: run.matched,
          catalogCoverage: run.catalogCoverage,
          items: included,
          dataGapCount: run.dataGaps.length,
        },
        selection: {
          eligible: eligible.length,
          included: included.length,
          omitted: eligible.length - included.length,
          rule: context.codes
            ? '仅分析用户勾选的候选；未纳入的候选未被分析'
            : '按筛选结果原顺序取前30只有效命中候选，并非AI排名；未纳入的候选未被分析',
        },
        coverage: '筛选规则与命中结果；未接入财报/公告，不代表基本面评估',
      };
    }
    if (context.kind === 'stock') {
      try {
        const data = await this.market.getBars(context.code, 'day', 'none');
        return this.barsSnapshot(data, context.date);
      } catch {
        return {
          available: false,
          reason: '个股行情暂时不可用，未接入财报与公告',
          capturedAt: new Date().toISOString(),
        };
      }
    }
    const indices = await Promise.all(
      (['sh000001', 'sz399001', 'sz399006'] as const).map(async (code) => {
        try {
          return {
            code,
            ...this.barsSnapshot(await this.market.getIndexBars(code, 'day'), context.date),
          };
        } catch {
          return { code, available: false, reason: '指数历史行情暂不可用' };
        }
      }),
    );
    return {
      available: indices.some((x) => x.available),
      indices,
      asOf: context.date,
      coverage: '仅指数历史量价；市场宽度、板块资金、公告财报未接入',
    };
  }
  private barsSnapshot(
    data: { items: MarketBar[]; source: string; fetchedAt: string },
    date: string,
  ) {
    const bars = data.items
      .filter((b) => b.complete && b.time.slice(0, 10) <= date)
      .sort((a, b) => a.time.localeCompare(b.time));
    if (!bars.length)
      return {
        available: false,
        reason: '所选日期超出本次取得的历史窗口，或没有可用K线（默认最多600根）',
        asOf: date,
      };
    const indicators = IndicatorEngine.calculate(bars, {
      ma: [5, 10, 20, 60],
      macd: [{ fast: 12, slow: 26, signal: 9 }],
      kdj: [{ period: 9, k: 3, d: 3 }],
      rsi: [6, 12, 24],
      boll: [{ period: 20, multiplier: 2 }],
    });
    return {
      available: true,
      source: data.source,
      fetchedAt: data.fetchedAt,
      asOf: bars.at(-1)!.time,
      requestedDate: date,
      adjustment: 'none',
      bars: bars.slice(-60),
      indicators: indicators.slice(-5).map((row, index, rows) => ({
        time: bars[bars.length - rows.length + index].time,
        ...row,
      })),
      coverage:
        '未复权历史K线，缺少值为预热不足；财报/公告未接入。历史日期由当前数据源回看，并非当时保存的数据版本。',
    };
  }
}
