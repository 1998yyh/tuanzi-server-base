import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ResearchWatch } from '../stock-research/research-watch.entity';
import { StockStrategiesService } from '../stock-strategies/stock-strategies.service';
import { listTemplates, type StrategyDefinition } from '../stock-strategies/strategy-definition';
import { StockMarketService } from '../stock-market/stock-market.service';
import type { CreateScreeningRunDto } from './dto/screening.dto';
import {
  ScreeningRunStatus,
  StockScreeningRun,
  type ScreeningResultItem,
} from './screening-run.entity';
import { StrategyEvaluator } from './strategy-evaluator';

export const screeningMatch = (matched: boolean, gap?: string): boolean => matched && !gap;

@Injectable()
export class StockScreeningService implements OnModuleInit {
  private readonly logger = new Logger(StockScreeningService.name);
  private executionTail: Promise<void> = Promise.resolve();
  constructor(
    @InjectRepository(StockScreeningRun) private readonly runRepo: Repository<StockScreeningRun>,
    @InjectRepository(ResearchWatch) private readonly watchRepo: Repository<ResearchWatch>,
    private readonly strategies: StockStrategiesService,
    private readonly market: StockMarketService,
  ) {}

  async onModuleInit(): Promise<void> {
    const stale = await this.runRepo.find({
      where: { status: In([ScreeningRunStatus.QUEUED, ScreeningRunStatus.RUNNING]) },
    });
    if (!stale.length) return;
    await this.runRepo.update(
      stale.map((run) => run.id),
      { status: ScreeningRunStatus.FAILED, errorMessage: '服务重启，任务未完成' },
    );
  }

  async create(userId: string, dto: CreateScreeningRunDto) {
    const definition = await this.definition(userId, dto.strategyId);
    const targets = await this.targets(userId, definition, dto.codes);
    const run = await this.runRepo.save(
      this.runRepo.create({
        userId,
        strategyId: dto.strategyId,
        strategySnapshot: structuredClone(definition),
        status: ScreeningRunStatus.QUEUED,
        asOf: new Date(),
        targetSnapshot: targets.items,
        catalogCoverage: targets.coverage,
        sampledAt: null,
        items: null,
        dataGaps: null,
      }),
    );
    this.executionTail = this.executionTail.catch(() => undefined).then(() => this.execute(run.id));
    return this.view(run);
  }

  async get(userId: string, id: string) {
    const run = await this.runRepo.findOne({ where: { id, userId } });
    if (!run) throw new NotFoundException('筛选任务不存在');
    return this.view(run);
  }

  async list(userId: string, page: number, limit: number) {
    const [runs, total] = await this.runRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: runs.map((run) => this.view(run)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private async execute(id: string): Promise<void> {
    try {
      const run = await this.runRepo.findOne({ where: { id } });
      if (!run) return;
      const started = await this.runRepo.update(
        { id, status: ScreeningRunStatus.QUEUED },
        {
          status: ScreeningRunStatus.RUNNING,
          total: run.targetSnapshot.length,
        },
      );
      if (started.affected !== 1) return;
      const requiredBars = this.requiredBars(run.strategySnapshot);
      let calendarDates: string[] | null = null;
      try {
        const calendar = await this.market.getIndexBars(
          'sh000001',
          run.strategySnapshot.period,
          requiredBars,
        );
        calendarDates = this.barsUpTo(calendar.items, run.asOf).map((bar) => bar.time.slice(0, 10));
      } catch {
        calendarDates = null;
      }
      const items: ScreeningResultItem[] = [];
      const dataGaps: Array<{ code: string; reason: string }> = [];
      for (let offset = 0; offset < run.targetSnapshot.length; offset += 5) {
        const batch = run.targetSnapshot.slice(offset, offset + 5);
        const evaluated = await Promise.all(
          batch.map(async (stock) => {
            try {
              const response = await this.market.getBars(
                stock.code,
                run.strategySnapshot.period,
                run.strategySnapshot.adjustment,
                requiredBars,
              );
              const bars = this.barsUpTo(response.items, run.asOf);
              const result = StrategyEvaluator.evaluate(bars, run.strategySnapshot);
              const last = bars.at(-1);
              const stale = last
                ? this.isStale(last.time, run.asOf, run.strategySnapshot.period)
                : true;
              const missing = calendarDates
                ? this.missingCalendarDates(bars, calendarDates, run.strategySnapshot.period)
                : null;
              const sourceGap = 'dataGap' in response ? response.dataGap : undefined;
              const gap = sourceGap
                ? sourceGap
                : !result.complete
                  ? '完整 K 线数量不足，指标仍在预热期'
                  : stale
                    ? '末根 K 线早于筛选截止交易日，无法区分停牌、休市或数据源缺口'
                    : calendarDates == null
                      ? '交易日历不可用，中间 K 线缺失情况未核验'
                      : missing?.length
                        ? `交易日历内缺少 ${missing.length} 根 K 线，无法区分停牌或数据源缺口`
                        : undefined;
              return {
                item: {
                  code: stock.code,
                  name: stock.name,
                  match: screeningMatch(result.match, gap),
                  conditions: result.conditions,
                  price: last?.close,
                  barTime: last?.time,
                  source: response.source,
                  fetchedAt: response.fetchedAt,
                  ...(result.indicators ? { indicators: result.indicators } : {}),
                  ...(gap ? { dataGap: gap } : {}),
                },
                gap,
              };
            } catch {
              return {
                item: {
                  code: stock.code,
                  name: stock.name,
                  match: false,
                  dataGap: '行情数据不可用',
                },
                gap: '行情数据不可用',
              };
            }
          }),
        );
        for (const result of evaluated) {
          items.push(result.item);
          if (result.gap) dataGaps.push({ code: result.item.code, reason: result.gap });
        }
        await this.runRepo.update(
          { id, status: ScreeningRunStatus.RUNNING },
          { checked: items.length },
        );
      }
      await this.runRepo.update(
        { id, status: ScreeningRunStatus.RUNNING },
        {
          status: ScreeningRunStatus.DONE,
          checked: items.length,
          matched: items.filter((item) => item.match).length,
          items,
          dataGaps,
          sampledAt: new Date(),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 255) : '筛选任务失败';
      await this.runRepo
        .update(
          { id, status: In([ScreeningRunStatus.QUEUED, ScreeningRunStatus.RUNNING]) },
          { status: ScreeningRunStatus.FAILED, errorMessage: message },
        )
        .catch(() => undefined);
    }
  }

  private async targets(userId: string, definition: StrategyDefinition, explicit?: string[]) {
    if (explicit?.length) {
      const catalog = await this.market.getCatalog(false);
      const names = new Map(catalog.items.map((item) => [item.code, item.name]));
      return {
        items: [...new Set(explicit)].map((code) => ({ code, name: names.get(code) ?? '' })),
        coverage: '请求指定代码',
      };
    }
    if (definition.scope === 'all') return this.market.getCatalog(true);
    const rows = await this.watchRepo.find({ where: { userId } });
    return {
      items: rows.map((row) => ({ code: row.code, name: row.name })),
      coverage: '当前用户观察池快照',
    };
  }

  private async definition(userId: string, strategyId: string): Promise<StrategyDefinition> {
    const template = listTemplates().find((item) => item.id === strategyId);
    return template?.definition ?? (await this.strategies.get(userId, strategyId)).definition;
  }

  private view(run: StockScreeningRun) {
    return {
      id: run.id,
      strategyId: run.strategyId,
      strategySnapshot: run.strategySnapshot,
      status: run.status,
      asOf: run.asOf,
      sampledAt: run.sampledAt,
      targetSnapshot: run.targetSnapshot,
      total: run.total,
      checked: run.checked,
      matched: run.matched,
      items: run.items ?? [],
      dataGaps: run.dataGaps ?? [],
      catalogCoverage: run.catalogCoverage,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private barsUpTo<T extends { time: string }>(bars: T[], asOf: Date): T[] {
    const china = new Date(asOf.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const date = `${china.getFullYear()}-${String(china.getMonth() + 1).padStart(2, '0')}-${String(china.getDate()).padStart(2, '0')}`;
    const afterClose =
      china.getHours() > 15 || (china.getHours() === 15 && china.getMinutes() >= 1);
    return bars.filter(
      (bar) => bar.time.slice(0, 10) < date || (bar.time.slice(0, 10) === date && afterClose),
    );
  }

  private requiredBars(definition: StrategyDefinition): number {
    return Math.min(
      1200,
      Math.max(
        60,
        ...definition.conditions.map((condition) =>
          condition.indicator === 'MACD'
            ? condition.parameters[1] + condition.parameters[2]
            : condition.parameters[0] + (condition.indicator === 'RSI' ? 1 : 0),
        ),
      ),
    );
  }

  private isStale(lastTime: string, asOf: Date, period: 'day' | 'week'): boolean {
    const expected = new Date(asOf.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    if (period === 'week') {
      const weekComplete =
        expected.getDay() === 0 ||
        expected.getDay() === 6 ||
        (expected.getDay() === 5 &&
          (expected.getHours() > 15 || (expected.getHours() === 15 && expected.getMinutes() >= 1)));
      const monday = new Date(expected);
      monday.setDate(expected.getDate() - ((expected.getDay() + 6) % 7));
      if (!weekComplete) monday.setDate(monday.getDate() - 7);
      return this.weekStart(lastTime) < this.dateOnly(monday);
    }
    if (expected.getHours() < 15) expected.setDate(expected.getDate() - 1);
    while (expected.getDay() === 0 || expected.getDay() === 6)
      expected.setDate(expected.getDate() - 1);
    return lastTime.slice(0, 10) < this.dateOnly(expected);
  }

  private missingCalendarDates<T extends { time: string }>(
    bars: T[],
    calendarDates: string[],
    period: 'day' | 'week',
  ): string[] {
    if (bars.length < 2) return [];
    if (period === 'week') {
      const actual = new Set(bars.map((bar) => this.weekStart(bar.time)));
      const firstWeek = this.weekStart(bars[0].time);
      const lastWeek = this.weekStart(bars.at(-1)!.time);
      return calendarDates.filter((date) => {
        const week = this.weekStart(date);
        return week >= firstWeek && week <= lastWeek && !actual.has(week);
      });
    }
    const first = bars[0].time.slice(0, 10);
    const last = bars.at(-1)!.time.slice(0, 10);
    const actual = new Set(bars.map((bar) => bar.time.slice(0, 10)));
    return calendarDates.filter((date) => date >= first && date <= last && !actual.has(date));
  }

  private weekStart(time: string): string {
    const utc = new Date(`${time.slice(0, 10)}T00:00:00Z`);
    utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
    return utc.toISOString().slice(0, 10);
  }

  private dateOnly(value: Date): string {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
}
