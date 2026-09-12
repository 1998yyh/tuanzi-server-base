import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { IndicatorEngine, StockMarketService } from '../stock-market';
import { evaluateAlert, isFreshCompletedDayBar, isFreshQuote } from './alert-evaluator';
import { StockAlertEvent } from './stock-alert-event.entity';
import { StockAlert } from './stock-alert.entity';
import { normalizeAlertParameters } from './dto/stock-alert.dto';

type CreateInput = Pick<StockAlert, 'code' | 'field' | 'operator' | 'threshold'> & {
  parameters?: number[];
};
type Observation = {
  value?: number;
  previousValue?: number;
  currentValue?: number;
  observedAt?: string;
  barTime?: string;
};

@Injectable()
export class StockAlertsService {
  private readonly logger = new Logger(StockAlertsService.name);

  constructor(
    @InjectRepository(StockAlert) private readonly alerts: Repository<StockAlert>,
    @InjectRepository(StockAlertEvent) private readonly events: Repository<StockAlertEvent>,
    private readonly dataSource: DataSource,
    private readonly market: StockMarketService,
  ) {}

  async create(userId: string, input: CreateInput) {
    const row = await this.alerts.save(
      this.alerts.create({
        ...input,
        parameters: normalizeAlertParameters(input.field, input.parameters),
        userId,
        enabled: true,
        lastMatch: null,
        lastBarTime: null,
        lastObservedAt: null,
        version: 1,
      }),
    );
    return this.alertView(row);
  }

  async list(userId: string, page: number, limit: number) {
    const [rows, total] = await this.alerts
      .createQueryBuilder('alert')
      .where('alert.userId = :userId', { userId })
      .orderBy('alert.createdAt', 'DESC')
      .addOrderBy('alert.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      items: rows.map((row) => this.alertView(row)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async update(userId: string, id: string, input: { enabled: boolean }) {
    const row = await this.ownedAlert(userId, id);
    const result = await this.alerts.update(
      { id, userId, version: row.version },
      { enabled: input.enabled, version: row.version + 1 },
    );
    if (result.affected !== 1) throw new NotFoundException('提醒不存在或已被修改');
    return this.alertView({ ...row, enabled: input.enabled, version: row.version + 1 });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.ownedAlert(userId, id);
    const result = await this.alerts.delete({ id, userId });
    if (result.affected !== 1) throw new NotFoundException('提醒不存在');
  }

  async listEvents(userId: string, page: number, limit: number) {
    const [rows, total] = await this.events
      .createQueryBuilder('event')
      .where('event.userId = :userId', { userId })
      .orderBy('event.createdAt', 'DESC')
      .addOrderBy('event.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      items: rows.map((row) => this.eventView(row)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async markRead(userId: string, id: string) {
    const row = await this.events.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('提醒事件不存在');
    if (row.readAt) return this.eventView(row);
    const readAt = new Date();
    await this.events.update({ id, userId, readAt: IsNull() }, { readAt });
    return this.eventView({ ...row, readAt });
  }

  @Cron('0 * * * * *')
  async monitor(): Promise<void> {
    const alerts = await this.alerts.find({ where: { enabled: true } });
    await Promise.all(
      alerts.map(async (alert) => {
        try {
          const observation = await this.observe(alert);
          if (observation) await this.applyObservation(alert.id, observation, new Date());
        } catch (error) {
          this.logger.warn(
            `提醒 ${alert.id} 本轮监控失败: ${error instanceof Error ? error.message : '未知错误'}`,
          );
        }
      }),
    );
  }

  async applyObservation(id: string, observation: Observation, now: Date): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const alertRepo = manager.getRepository(StockAlert);
      const eventRepo = manager.getRepository(StockAlertEvent);
      const alert = await alertRepo
        .createQueryBuilder('alert')
        .setLock('pessimistic_write')
        .where('alert.id = :id', { id })
        .getOne();
      if (
        !alert ||
        !alert.enabled ||
        (observation.barTime && alert.lastBarTime && observation.barTime <= alert.lastBarTime) ||
        (observation.observedAt &&
          alert.lastObservedAt &&
          observation.observedAt <= alert.lastObservedAt)
      )
        return;
      const result = evaluateAlert(alert, { ...observation, lastMatch: alert.lastMatch });
      if (!result) return;
      const nextVersion = alert.version + 1;
      if (result.trigger) {
        await eventRepo.save(
          eventRepo.create({
            alertId: alert.id,
            alertVersion: nextVersion,
            userId: alert.userId,
            code: alert.code,
            message: this.message(alert),
            readAt: null,
            deliveryStatus: 'queued',
          }),
        );
      }
      const update = await alertRepo.update(
        { id: alert.id, version: alert.version, enabled: true },
        {
          lastMatch: result.match,
          lastBarTime: observation.barTime ?? alert.lastBarTime,
          lastObservedAt: observation.observedAt ?? alert.lastObservedAt,
          version: nextVersion,
          updatedAt: now,
        },
      );
      if (update.affected !== 1) throw new ConflictException('提醒状态已变化，本轮触发已取消');
    });
  }

  private async observe(alert: StockAlert): Promise<Observation | null> {
    const now = new Date();
    if (alert.field === 'price' || alert.field === 'change') {
      const quote = (await this.market.getQuotes([alert.code])).items.find(
        (item) => item.code === alert.code,
      );
      if (!quote?.asOf || !isFreshQuote(quote.asOf, now)) return null;
      return {
        value: alert.field === 'price' ? quote.price : quote.change,
        observedAt: quote.asOf,
      };
    }
    const result = await this.market.getBars(alert.code, 'day', 'qfq');
    if (result.items.length < 2) return null;
    const currentIndex = result.items.length - 1;
    const currentBar = result.items[currentIndex];
    if (!isFreshCompletedDayBar(currentBar, now)) return null;
    const parameters = normalizeAlertParameters(alert.field, alert.parameters ?? undefined);
    if (!parameters) return null;
    const request =
      alert.field === 'MA'
        ? { ma: [parameters[0]] }
        : alert.field === 'MACD'
          ? { macd: [{ fast: parameters[0], slow: parameters[1], signal: parameters[2] }] }
          : alert.field === 'KDJ'
            ? { kdj: [{ period: parameters[0], k: parameters[1], d: parameters[2] }] }
            : alert.field === 'RSI'
              ? { rsi: [parameters[0]] }
              : { boll: [{ period: parameters[0], multiplier: parameters[1] }] };
    const indicators = IndicatorEngine.calculate(result.items, request);
    const previous = indicators[currentIndex - 1];
    const current = indicators[currentIndex];
    let observation: Observation;
    if (alert.field === 'MA') {
      const key = String(parameters[0]);
      const previousMa = previous.ma[key];
      const currentMa = current.ma[key];
      if (previousMa == null || currentMa == null) return null;
      observation = {
        previousValue: result.items[currentIndex - 1].close - previousMa,
        currentValue: currentBar.close - currentMa,
      };
    } else if (alert.field === 'MACD') {
      const key = parameters.join(':');
      const previousMacd = previous.macd[key];
      const currentMacd = current.macd[key];
      if (!previousMacd || !currentMacd) return null;
      observation = {
        previousValue: previousMacd.dif - previousMacd.dea,
        currentValue: currentMacd.dif - currentMacd.dea,
      };
    } else if (alert.field === 'KDJ') {
      const key = parameters.join(':');
      const previousKdj = previous.kdj[key];
      const currentKdj = current.kdj[key];
      if (!previousKdj || !currentKdj) return null;
      observation = {
        previousValue: previousKdj.k - previousKdj.d,
        currentValue: currentKdj.k - currentKdj.d,
      };
    } else if (alert.field === 'RSI') {
      observation = { value: current.rsi[String(parameters[0])] ?? undefined };
    } else {
      const key = parameters.join(':');
      const previousBoll = previous.boll[key];
      const currentBoll = current.boll[key];
      if (!previousBoll || !currentBoll) return null;
      observation = {
        previousValue:
          result.items[currentIndex - 1].close -
          (alert.operator === 'gte' ? previousBoll.upper : previousBoll.lower),
        currentValue:
          currentBar.close - (alert.operator === 'gte' ? currentBoll.upper : currentBoll.lower),
      };
    }
    return { ...observation, barTime: currentBar.time };
  }

  private async ownedAlert(userId: string, id: string): Promise<StockAlert> {
    const row = await this.alerts.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('提醒不存在');
    return row;
  }

  private message(alert: StockAlert): string {
    if (['MA', 'MACD', 'KDJ', 'BOLL'].includes(alert.field))
      return `${alert.code} 日线 ${alert.field} 出现${alert.operator === 'gte' ? '上穿' : '下穿'}`;
    const label = alert.field === 'price' ? '价格' : alert.field === 'change' ? '涨跌幅' : 'RSI';
    return `${alert.code} ${label}已${alert.operator === 'gte' ? '达到或高于' : '达到或低于'} ${Number(alert.threshold)}`;
  }

  private alertView(row: StockAlert) {
    return {
      id: row.id,
      code: row.code,
      field: row.field,
      operator: row.operator,
      threshold: Number(row.threshold),
      parameters: row.parameters,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private eventView(row: StockAlertEvent) {
    return {
      id: row.id,
      code: row.code,
      message: row.message,
      createdAt: row.createdAt,
      readAt: row.readAt,
      deliveryStatus: row.deliveryStatus,
    };
  }
}
