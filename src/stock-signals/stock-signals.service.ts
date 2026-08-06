import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { User } from '../users/users.entity';
import { ScanRunStatus, StockSignalScanRun } from './entities/scan-run.entity';
import { StockSignal } from './entities/stock-signal.entity';
import { STOCK_LIST, type StockListItem } from './stock-list.data';
import { SinaScannerService } from './sina-scanner.service';
import type { CreateScanDto } from './dto/create-scan.dto';

type CurrentUser = Omit<User, 'password'>;

/** 结果表格行（B 信号命中项） */
export interface BSignalItem {
  code: string;
  market: string;
  name: string;
}

/** 沪深主板代码段（与原 b-signal-scanner 页面一致，排除创业板/科创板） */
const MAIN_BOARD_CODE = /^(?:000|001|002|003|600|601|603|605)\d{3}$/;
const CODE_PATTERN = /^(?:(sh|sz))?(\d{6})$/;
/** 任务进度写库的节流粒度：每扫完 50 只更新一次 */
const PROGRESS_FLUSH_EVERY = 50;
/** upsert 单批行数上限 */
const UPSERT_CHUNK = 500;

/**
 * B 信号筛选业务逻辑：扫描任务状态机 + 按日期缓存 + 全量落库。
 *
 * 缓存契约：某日期存在 done 任务时，非强制刷新直接返回缓存；
 * 强制刷新创建新任务重扫并 upsert 覆盖（历史以最新 done 任务为准）。
 */
@Injectable()
export class StockSignalsService {
  private readonly logger = new Logger(StockSignalsService.name);
  /** 代码 → 清单项索引（名称、市场前缀以清单为准） */
  private readonly stockMap = new Map(STOCK_LIST.map((s) => [s.code, s]));

  constructor(
    @InjectRepository(StockSignalScanRun)
    private readonly runRepo: Repository<StockSignalScanRun>,
    @InjectRepository(StockSignal)
    private readonly signalRepo: Repository<StockSignal>,
    private readonly scanner: SinaScannerService,
  ) {}

  // ---- 扫描入口 ----

  /**
   * 请求扫描。全市场走异步任务；指定 codes 走同步抓取。
   * 返回 { run, cached }（全市场）或 { result }（指定代码）。
   */
  async requestScan(user: CurrentUser, dto: CreateScanDto) {
    const date = dto.date ?? this.chinaToday();
    if (date > this.chinaToday()) {
      throw new BadRequestException('不能查询未来日期');
    }
    if (this.isWeekend(date)) {
      throw new BadRequestException('周末没有交易数据，请选择交易日');
    }

    if (dto.codes?.length) {
      return { result: await this.scanCodes(date, dto.codes, !!dto.refresh) };
    }

    const latest = await this.latestRun(date);
    if (latest?.status === ScanRunStatus.DONE && !dto.refresh) {
      return { run: latest, cached: true };
    }
    if (latest?.status === ScanRunStatus.PENDING || latest?.status === ScanRunStatus.RUNNING) {
      return { run: latest, cached: false };
    }

    const run = await this.runRepo.save(
      this.runRepo.create({ queryDate: date, createdBy: user.id }),
    );
    // 异步执行，不阻塞响应；失败在 executeRun 内部落入 run.status
    void this.executeRun(run.id);
    return { run, cached: false };
  }

  /** 任务状态（轮询用）：done 时附 B 列表 */
  async getRun(id: string) {
    const run = await this.runRepo.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`扫描任务 #${id} 不存在`);
    if (run.status !== ScanRunStatus.DONE) return { run };
    return { run, items: await this.findBItems(run.queryDate) };
  }

  // ---- 结果查询（公开） ----

  /** 某日结果明细：取该日期最新 done 任务，没有则 404（前端据此提示「尚未扫描」） */
  async getByDate(date: string) {
    const run = await this.latestDoneRun(date);
    if (!run) throw new NotFoundException('该日期还没有扫描数据，请先发起扫描');
    return {
      date,
      items: await this.findBItems(date),
      found: run.found,
      checked: run.checked,
      total: run.total,
      failedCodes: run.failedCodes ?? [],
      scannedAt: run.updatedAt,
    };
  }

  /** 历史日期列表：每个有 done 任务的日期取最新一次 */
  async getDates() {
    const runs = await this.runRepo.find({
      where: { status: ScanRunStatus.DONE },
      order: { queryDate: 'DESC', createdAt: 'DESC' },
    });
    const seen = new Set<string>();
    return runs
      .filter((r) => (seen.has(r.queryDate) ? false : (seen.add(r.queryDate), true)))
      .map((r) => ({
        date: r.queryDate,
        found: r.found,
        checked: r.checked,
        total: r.total,
        scannedAt: r.updatedAt,
      }));
  }

  // ---- 全市场异步任务 ----

  private async executeRun(runId: string) {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) return;

    await this.runRepo.update(runId, {
      status: ScanRunStatus.RUNNING,
      total: STOCK_LIST.length,
    });

    try {
      let lastFlushed = 0;
      const { results, failures } = await this.scanner.scan(
        STOCK_LIST,
        run.queryDate,
        async (checked) => {
          if (checked - lastFlushed >= PROGRESS_FLUSH_EVERY || checked === STOCK_LIST.length) {
            lastFlushed = checked;
            await this.runRepo.update(runId, { checked });
          }
        },
      );

      // 全量落库：当日无信号值也存空串（负缓存——区别「无信号」与「未扫描」，
      // 指定代码查询命中负缓存后不再重复外呼）
      const rows = results.map((r) => ({
        signalDate: run.queryDate,
        code: r.item.code,
        market: r.item.market,
        name: r.item.name,
        value: r.value ?? '',
        runId,
      }));
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        await this.signalRepo.upsert(rows.slice(i, i + UPSERT_CHUNK), {
          conflictPaths: ['signalDate', 'code'],
        });
      }

      await this.runRepo.update(runId, {
        status: ScanRunStatus.DONE,
        checked: results.length + failures.length,
        found: rows.filter((r) => r.value === '1').length,
        failedCodes: failures,
      });
    } catch (err) {
      this.logger.error(`扫描任务 ${runId} 失败`, (err as Error).stack);
      await this.runRepo.update(runId, { status: ScanRunStatus.FAILED });
    }
  }

  // ---- 指定代码同步扫描 ----

  private async scanCodes(date: string, rawCodes: string[], refresh: boolean) {
    const items: StockListItem[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();

    for (const raw of rawCodes) {
      const match = raw.trim().toLowerCase().match(CODE_PATTERN);
      if (!match || !MAIN_BOARD_CODE.test(match[2])) {
        invalid.push(raw);
        continue;
      }
      const code = match[2];
      if (seen.has(code)) continue;
      seen.add(code);
      const known = this.stockMap.get(code);
      items.push(
        known ?? {
          code,
          market: (match[1] as 'sh' | 'sz' | undefined) ?? (code.startsWith('6') ? 'sh' : 'sz'),
          name: '',
        },
      );
    }

    // 缓存命中检查（强制刷新则全部重抓）
    const cached = refresh
      ? []
      : await this.signalRepo.find({
          where: { signalDate: date, code: In(items.map((i) => i.code)) },
        });
    const cachedMap = new Map(cached.map((s) => [s.code, s.value]));
    const toFetch = items.filter((i) => !cachedMap.has(i.code));

    const { results, failures } = await this.scanner.scan(toFetch, date);
    if (results.length) {
      await this.signalRepo.upsert(
        results.map((r) => ({
          signalDate: date,
          code: r.item.code,
          market: r.item.market,
          name: r.item.name,
          value: r.value ?? '',
          runId: null,
        })),
        { conflictPaths: ['signalDate', 'code'] },
      );
    }

    // 汇总：缓存 + 新抓，B = value '1'
    const valueOf = new Map<string, string>(cached.map((s) => [s.code, s.value]));
    for (const r of results) {
      valueOf.set(r.item.code, r.value ?? '');
    }
    const bItems = items
      .filter((i) => valueOf.get(i.code) === '1')
      .map((i) => ({ code: i.code, market: i.market, name: i.name }));

    return {
      date,
      items: bItems,
      requested: items.length,
      cachedCount: cached.length,
      fetchedCount: results.length,
      failed: failures,
      invalid,
    };
  }

  // ---- 私有工具 ----

  private latestRun(date: string) {
    return this.runRepo.findOne({
      where: { queryDate: date },
      order: { createdAt: 'DESC' },
    });
  }

  private async latestDoneRun(date: string) {
    const runs = await this.runRepo.find({
      where: { queryDate: date, status: ScanRunStatus.DONE },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    return runs[0] ?? null;
  }

  private async findBItems(date: string): Promise<BSignalItem[]> {
    const rows = await this.signalRepo.find({
      where: { signalDate: date, value: '1' },
      order: { code: 'ASC' },
    });
    return rows.map((r) => ({ code: r.code, market: r.market, name: r.name }));
  }

  /** 是否周末（按日历日判断，与服务器时区无关） */
  private isWeekend(date: string): boolean {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
  }

  /** 北京时间今天（YYYY-MM-DD） */
  private chinaToday(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const v = Object.fromEntries(
      parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    );
    return `${v.year}-${v.month}-${v.day}`;
  }
}
