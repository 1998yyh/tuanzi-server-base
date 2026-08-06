import { Injectable, Logger } from '@nestjs/common';
import type { StockListItem } from './stock-list.data';

/** 单只股票当日信号抓取结果；value 为 null 表示当日无信号值 */
export interface SignalFetchResult {
  item: StockListItem;
  value: string | null;
}

const API_ROOT = 'https://finance.sina.com.cn/finance/hq/upbs';
const CONCURRENCY = 12;
const TIMEOUT_MS = 10_000;

/**
 * 新浪多空信号（upbs）抓取器。
 * 原 b-signal-scanner 页面用 JSONP 逐只请求，服务端化后改为直接 HTTP：
 * 响应是 `var _touzibullbear_sh600000={...};` 形式的 JS，正则解出 JSON 取当日值。
 */
@Injectable()
export class SinaScannerService {
  private readonly logger = new Logger(SinaScannerService.name);

  /** 抓取单只股票在指定日期的信号值；失败抛错（由调用方收集为失败列表） */
  async fetchOne(item: StockListItem, date: string): Promise<SignalFetchResult> {
    const id = `${item.market}${item.code}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${API_ROOT}/${id}.js`, {
        signal: controller.signal,
        headers: {
          // 新浪财经接口校验 Referer，缺了会 403
          Referer: 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // 响应是 `var _touzibullbear_xxx={...};`（尾部可能带反爬注释 /* ... */），
      // 数据是无嵌套对象的 JSON，取第一个 { 到对应 } 即可
      const match = text.match(/=\s*(\{[^}]*\})/);
      if (!match) throw new Error('响应格式无法解析');
      const data = JSON.parse(match[1]) as Record<string, string>;
      // 日期键可能是 YYYY-MM-DD 或 YYYYMMDD，两种都判
      const compact = date.replace(/-/g, '');
      const value = data[date] ?? data[compact] ?? null;
      return { item, value };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 并发扫描一批股票（默认 12 路）。单只失败不中断整体，收集到 failures。
   * onProgress 在每只完成后回调（已检查数、累计结果），供调用方更新任务进度。
   */
  async scan(
    items: StockListItem[],
    date: string,
    onProgress?: (checked: number) => void | Promise<void>,
  ): Promise<{ results: SignalFetchResult[]; failures: string[] }> {
    const results: SignalFetchResult[] = [];
    const failures: string[] = [];
    let cursor = 0;
    let checked = 0;

    const worker = async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          results.push(await this.fetchOne(item, date));
        } catch (err) {
          failures.push(`${item.market.toUpperCase()}${item.code}`);
          this.logger.debug(`抓取失败 ${item.market}${item.code}: ${(err as Error).message}`);
        }
        checked += 1;
        await onProgress?.(checked);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return { results, failures };
  }
}
