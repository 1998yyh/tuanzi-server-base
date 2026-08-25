import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ScanRunStatus } from './entities/scan-run.entity';
import { SinaScannerService } from './sina-scanner.service';
import { StockSignalsService } from './stock-signals.service';
import { WatchlistService } from './watchlist.service';
import type { StockListItem } from './stock-list.data';

/**
 * 全市场扫描等待上限：3044 只 / 12 并发正常几分钟跑完，留 30 分钟余量；
 * 超时放弃本轮评估（下一轮 cron 或手动 check 会补上），不无限挂住 cron。
 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** 节假日探针用票：浦发银行（沪市蓝筹，upbs 在交易日必有当日键） */
const PROBE: StockListItem = { code: '600000', market: 'sh', name: '浦发银行' };

/**
 * 观察池每日例行（Asia/Shanghai，周一至五）：
 *   10:00 早盘一轮、14:50 尾盘一轮，流程均为
 *   「节假日探针 → 当日全市场扫描（refresh 强制重抓，等落定）→ 全站观察池 S 评估」。
 * 单实例假设：与 BackgroundTasksService / GenerationPollerService 一致，多实例部署需加 leader 锁。
 */
@Injectable()
export class WatchlistCronService {
  private readonly logger = new Logger(WatchlistCronService.name);
  /** 重入保护：上一轮还没跑完（在等扫描落定）时直接跳过本轮 */
  private running = false;

  constructor(
    private readonly signalsService: StockSignalsService,
    private readonly watchlistService: WatchlistService,
    private readonly scanner: SinaScannerService,
  ) {}

  @Cron('0 10 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async morningRun(): Promise<void> {
    await this.dailyFlow('10:00');
  }

  @Cron('50 14 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async afternoonRun(): Promise<void> {
    await this.dailyFlow('14:50');
  }

  private async dailyFlow(label: string): Promise<void> {
    if (this.running) {
      this.logger.warn(`上一轮例行尚未结束，${label} 轮跳过`);
      return;
    }
    this.running = true;
    try {
      const today = this.signalsService.chinaToday();

      // 1. 节假日探针：upbs 返回里没有今天的键 = 非交易日，整天跳过。
      //    探针本身失败（网络故障等）同样跳过——全市场扫描也只会大面积失败。
      let probeValue: string | null;
      try {
        probeValue = (await this.scanner.fetchOne(PROBE, today)).value;
      } catch (e) {
        this.logger.warn(`节假日探针请求失败，${label} 轮跳过: ${(e as Error).message}`);
        return;
      }
      if (probeValue === null) {
        this.logger.log(`${today} 非交易日（探针无当日数据），${label} 轮跳过扫描与评估`);
        return;
      }

      // 2. 当日全市场扫描：cron 一律 refresh 强制重抓——14:50 轮的核心目的就是
      //    抓 10:00 之后新出现的当日信号（upsert 覆盖，历史以最新 done run 为准）；
      //    进行中的 run 仍复用，不并发重扫。分钟级异步任务，必须轮询到终态再评估
      const run = await this.signalsService.ensureMarketRun(today, true);
      const final =
        run.status === ScanRunStatus.DONE
          ? run
          : await this.signalsService.waitRunFinished(run.id, RUN_TIMEOUT_MS);
      if (final?.status !== ScanRunStatus.DONE) {
        this.logger.warn(
          `当日全市场扫描未落定（run ${run.id}，status=${final?.status ?? 'missing'}），` +
            `${label} 轮跳过 S 评估`,
        );
        return;
      }

      // 3. 全站观察池 S 评估
      const triggered = await this.watchlistService.evaluateWatching();
      this.logger.log(`观察池 ${label} 轮例行完成：新触发 ${triggered} 项`);
    } catch (e) {
      this.logger.error(`观察池 ${label} 轮例行异常`, (e as Error).stack ?? e);
    } finally {
      this.running = false;
    }
  }
}
