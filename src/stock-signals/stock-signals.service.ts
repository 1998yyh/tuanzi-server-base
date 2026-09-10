import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
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

/** 沪深主板代码段（与原 b-signal-scanner 页面一致，排除创业板/科创板）；观察池模块复用 */
export const MAIN_BOARD_CODE = /^(?:000|001|002|003|600|601|603|605)\d{3}$/;
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
export class StockSignalsService implements OnModuleInit {
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

  /**
   * 进程启动时恢复遗留任务：PENDING/RUNNING 都是上一进程退出时失联的任务
   * （状态机只能由存活进程推进，原进程已退出不会再更新），统一置为 FAILED，
   * 避免前端轮询永久卡住。onModuleInit 只在进程启动瞬间执行，此时不可能有
   * 活跃任务，不会误伤正常运行的 run。
   */
  async onModuleInit() {
    const stale = await this.runRepo.find({
      where: [{ status: ScanRunStatus.PENDING }, { status: ScanRunStatus.RUNNING }],
    });
    if (stale.length === 0) return;
    await this.runRepo.update(
      stale.map((r) => r.id),
      { status: ScanRunStatus.FAILED },
    );
    this.logger.log(
      `进程重启恢复：将 ${stale.length} 个遗留扫描任务（pending/running）置为 FAILED`,
    );
  }

  // ---- 扫描入口 ----

  /**
   * 请求扫描。全市场走异步任务；指定 codes 走同步抓取。
   * 返回 { run, cached }（全市场）或 { result }（指定代码）。
   */
  async requestScan(user: CurrentUser, dto: CreateScanDto) {
    const date = dto.date ?? this.chinaToday();
    this.assertValidDate(date);
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
    // 异步执行，不阻塞响应；失败在 executeRun 内部落入 run.status，
    // 兜底 catch 防止任何未捕获 rejection
    void this.executeRun(run.id).catch((e) =>
      this.logger.error('全市场扫描任务异常', e?.stack ?? e),
    );
    return { run, cached: false };
  }

  /** 任务状态（轮询用）：done 时附 B 列表；公开接口剔除 createdBy，不泄露触发人 */
  async getRun(id: string) {
    const run = await this.runRepo.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`扫描任务 #${id} 不存在`);
    const { createdBy, ...rest } = run;
    if (run.status !== ScanRunStatus.DONE) return { run: rest };
    return { run: rest, items: await this.findBItems(run.queryDate) };
  }

  // ---- 结果查询（公开） ----

  /** 某日结果明细：取该日期最新 done 任务，没有则 404（前端据此提示「尚未扫描」） */
  async getByDate(date: string) {
    this.assertValidDate(date);
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

  /**
   * 异步执行全市场扫描（fire-and-forget）。任何 DB 故障（含状态写库失败）都只
   * 落入 status=failed 并记日志，promise 绝不向上抛；调用方另挂兜底 catch 双保险。
   */
  private async executeRun(runId: string) {
    try {
      const run = await this.runRepo.findOne({ where: { id: runId } });
      if (!run) return;

      await this.runRepo.update(runId, {
        status: ScanRunStatus.RUNNING,
        total: STOCK_LIST.length,
      });

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
      this.logger.error(`扫描任务 ${runId} 失败`, (err as Error).stack ?? err);
      try {
        await this.runRepo.update(runId, { status: ScanRunStatus.FAILED });
      } catch (updateErr) {
        // 状态写库失败只记日志，绝不向上抛——否则 executeRun 的 promise 会 rejected
        this.logger.error(
          `扫描任务 ${runId} 状态置为失败时写库异常`,
          (updateErr as Error).stack ?? updateErr,
        );
      }
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

  // ---- 观察池复用的内部入口 ----

  /**
   * 内部入口（观察池 cron 用）：确保某日全市场扫描已触发。
   * 与 requestScan 同一契约：pending/running 任务总是复用（不并发重扫）；
   * done 任务在 refresh=false 时复用缓存，refresh=true 时新建 run 强制重抓——
   * cron 两轮都是 refresh（14:50 轮的核心目的就是抓 10:00 之后新出现的当日信号），
   * 手动用户扫描的缓存契约不受影响。failed 或无任务时新建 run。
   * 系统触发，createdBy 置 null。调用方需自行保证 date 是合法交易日。
   */
  async ensureMarketRun(date: string, refresh = false): Promise<StockSignalScanRun> {
    const latest = await this.latestRun(date);
    if (latest?.status === ScanRunStatus.PENDING || latest?.status === ScanRunStatus.RUNNING) {
      return latest;
    }
    if (latest?.status === ScanRunStatus.DONE && !refresh) {
      return latest;
    }
    const run = await this.runRepo.save(this.runRepo.create({ queryDate: date, createdBy: null }));
    // 与 requestScan 同一姿势：异步执行不阻塞，兜底 catch 防未捕获 rejection
    void this.executeRun(run.id).catch((e) =>
      this.logger.error('全市场扫描任务异常', e?.stack ?? e),
    );
    return run;
  }

  /**
   * 内部入口（观察池 cron 用）：轮询 run 到终态（done/failed）或超时。
   * 全市场扫描是分钟级异步任务，cron 必须等落定后再做 S 评估；
   * 超时返回最后一瞥的状态（可能仍是 running），由调用方决定放弃与否。
   */
  async waitRunFinished(
    runId: string,
    timeoutMs: number,
    intervalMs = 10_000,
  ): Promise<StockSignalScanRun | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.runRepo.findOne({ where: { id: runId } });
      if (!run) return null;
      if (run.status === ScanRunStatus.DONE || run.status === ScanRunStatus.FAILED) return run;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return this.runRepo.findOne({ where: { id: runId } });
  }

  /**
   * 内部入口（观察池手动 check 用）：同步刷新指定代码当日信号（强制重抓，忽略缓存）。
   * 调用方保证 codes 非空；空池子必须先短路——scanCodes 不接受空数组语义。
   */
  async refreshCodes(date: string, codes: string[]) {
    return this.scanCodes(date, codes, true);
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

  /**
   * 校验 YYYY-MM-DD 是否为真实存在的日历日期。
   * DTO 正则只保证形状，`2026-02-30` 之类会打到 MySQL 报 500，这里统一在
   * service 入口拦截；isWeekend 的 Invalid Date 问题随之自然解决。
   */
  private assertValidDate(date: string): void {
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
      throw new BadRequestException('date 不是有效的日期');
    }
  }

  /** 是否周末（按日历日判断，与服务器时区无关） */
  private isWeekend(date: string): boolean {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
  }

  /** 北京时间今天（YYYY-MM-DD）；public：观察池 cron 复用 */
  chinaToday(): string {
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
