import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { STOCK_LIST } from '../stock-signals/stock-list.data';
import { IndicatorEngine } from './indicator-engine';
import type { MarketBar, MarketPeriod, PriceAdjustment } from './market.types';

const SOURCE = 'eastmoney';
const QUOTE_HOST = 'https://push2.eastmoney.com';
const HISTORY_HOST = 'https://push2his.eastmoney.com';
const TENCENT_HOST = 'https://web.ifzq.gtimg.cn';
const CACHE_MS = 30_000;
const CATALOG_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

export interface StockCatalogItem {
  code: string;
  name: string;
  market: 'sh' | 'sz' | 'bj';
}

@Injectable()
export class StockMarketService {
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  async getQuotes(codes: string[]) {
    const normalized = [...new Set(codes)];
    const key = `quotes:${normalized.join(',')}`;
    return this.cached(key, CACHE_MS, async () => {
      const secids = normalized.map((code) => this.secid(code)).join(',');
      const url = `${QUOTE_HOST}/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14,f124&secids=${encodeURIComponent(secids)}`;
      const data = (await this.json(url)) as { data?: { diff?: Array<Record<string, unknown>> } };
      const items = (data.data?.diff ?? [])
        .map((row) => ({
          code: String(row.f12),
          name: String(row.f14 ?? ''),
          price: Number(row.f2),
          change: Number(row.f3),
          changeAmount: Number(row.f4),
          source: SOURCE,
          asOf: Number(row.f124) > 0 ? new Date(Number(row.f124) * 1000).toISOString() : null,
        }))
        .filter(
          (item) =>
            item.price > 0 && Number.isFinite(item.change) && Number.isFinite(item.changeAmount),
        );
      if (items.length !== normalized.length)
        throw new BadGatewayException('行情源未返回全部股票的有效报价');
      const fetchedAt = new Date().toISOString();
      return { items, source: SOURCE, fetchedAt };
    });
  }

  async getIndices() {
    return this.getQuotesBySecids([
      ['sh000001', '1.000001'],
      ['sz399001', '0.399001'],
      ['sz399006', '0.399006'],
    ]);
  }

  async getIndexBars(
    code: 'sh000001' | 'sz399001' | 'sz399006',
    period: 'day' | 'week',
    limit = 600,
  ) {
    const ids = { sh000001: '1.000001', sz399001: '0.399001', sz399006: '0.399006' };
    if (!ids[code] || !['day', 'week'].includes(period))
      throw new BadGatewayException('指数代码或周期无效');
    const bounded = Math.min(Math.max(limit, 1), 1200);
    let source = SOURCE;
    let items: MarketBar[];
    let primary: { data?: { klines?: string[] } } | null = null;
    try {
      const url = `${HISTORY_HOST}/api/qt/stock/kline/get?secid=${ids[code]}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=${period === 'day' ? 101 : 102}&fqt=0&end=20500101&lmt=${bounded}`;
      primary = (await this.json(url)) as { data?: { klines?: string[] } };
    } catch {
      primary = null;
    }
    if (primary) items = this.normalizeBars(primary.data?.klines ?? [], period);
    else items = [];
    if (!items.length) {
      items = await this.tencentBars(code, period, 'none', bounded);
      source = 'tencent';
    }
    if (!items.length) throw new BadGatewayException('行情源未返回有效指数 K 线');
    return {
      code,
      period,
      adjustment: 'none',
      source,
      fetchedAt: new Date().toISOString(),
      items,
    };
  }

  async getBars(code: string, period: MarketPeriod, adjustment: PriceAdjustment, limit = 600) {
    if (period === 'minute' && adjustment !== 'none')
      throw new BadRequestException('分钟线仅支持 none，不提供复权分钟数据');
    const boundedLimit = Math.min(Math.max(limit, 1), 1200);
    const key = `bars:${code}:${period}:${adjustment}:${boundedLimit}`;
    return this.cached(key, CACHE_MS, async () => {
      if (period === 'minute') return this.minuteBars(code, boundedLimit);
      const klt = period === 'day' ? 101 : period === 'week' ? 102 : 1;
      const fqt = adjustment === 'none' ? 0 : adjustment === 'qfq' ? 1 : 2;
      const requestLimit = boundedLimit;
      const url = `${HISTORY_HOST}/api/qt/stock/kline/get?secid=${this.secid(code)}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=${klt}&fqt=${fqt}&end=20500101&lmt=${requestLimit}`;
      let source = SOURCE;
      let items: MarketBar[];
      let primary: { data?: { klines?: string[] } } | null = null;
      try {
        primary = (await this.json(url)) as { data?: { klines?: string[] } };
      } catch {
        primary = null;
      }
      if (primary) items = this.normalizeBars(primary.data?.klines ?? [], period);
      else items = [];
      if (!items.length) {
        if (this.market(code) === 'bj')
          throw new BadGatewayException('东方财富 K 线不可用，腾讯备用源未验证支持北交所');
        items = await this.tencentBars(code, period, adjustment, boundedLimit);
        source = 'tencent';
      }
      if (!items.length) throw new BadGatewayException('行情源未返回有效 K 线');
      const indicatorRows = IndicatorEngine.calculate(items, {
        ma: [5, 10, 20, 60],
        macd: [{ fast: 12, slow: 26, signal: 9 }],
        kdj: [{ period: 9, k: 3, d: 3 }],
        rsi: [6, 12, 24],
        boll: [{ period: 20, multiplier: 2 }],
      });
      const fetchedAt = new Date().toISOString();
      return {
        code,
        period,
        adjustment,
        source,
        fetchedAt,
        items,
        indicators: indicatorRows,
        ...(items.length < boundedLimit
          ? { dataGap: `${source} 仅返回 ${items.length}/${boundedLimit} 根 K 线` }
          : {}),
      };
    });
  }

  async search(query: string) {
    const q = query.trim().toLowerCase();
    const catalog = await this.getCatalog(false);
    return {
      items: catalog.items
        .filter((item) => item.code.includes(q) || item.name.toLowerCase().includes(q))
        .slice(0, 50),
      coverage: catalog.coverage,
    };
  }

  async getCatalog(
    requireAll = true,
  ): Promise<{ items: StockCatalogItem[]; coverage: string; source: string }> {
    try {
      return await this.cached('catalog:all', CATALOG_CACHE_MS, async () => {
        const fs = 'm:0+t:6,m:0+t:80,m:0+t:81+s:2048,m:1+t:2,m:1+t:23';
        const load = (pn: number) =>
          this.json(
            `${QUOTE_HOST}/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(fs)}&fields=f12,f14`,
          ) as Promise<{ data?: { total?: number; diff?: Array<Record<string, unknown>> } }>;
        const first = await load(1);
        const total = Number(first.data?.total ?? 0);
        const pages = [first];
        for (let pn = 2; pn <= Math.ceil(total / 100); pn += 4)
          pages.push(
            ...(await Promise.all(
              Array.from({ length: Math.min(4, Math.ceil(total / 100) - pn + 1) }, (_, i) =>
                load(pn + i),
              ),
            )),
          );
        const items = pages
          .flatMap((data) => data.data?.diff ?? [])
          .map((row) => {
            const code = String(row.f12);
            const name = String(row.f14 ?? '');
            return { code, name, market: this.market(code) };
          })
          .filter((item) => /^\d{6}$/.test(item.code) && item.name) as StockCatalogItem[];
        const unique = [...new Map(items.map((item) => [item.code, item])).values()];
        if (total < 4000 || unique.length < total)
          throw new BadGatewayException('全市场股票目录不完整');
        return {
          items: unique,
          coverage: `沪深京 A 股（上游实时目录，共 ${unique.length} 只）`,
          source: SOURCE,
        };
      });
    } catch {
      if (requireAll) throw new ServiceUnavailableException('全市场股票目录暂时不可用');
      return {
        items: STOCK_LIST.map((item) => ({ ...item, market: item.market as 'sh' | 'sz' })),
        coverage: '沪深主板静态目录（3044 只）',
        source: 'repository-static-catalog',
      };
    }
  }

  private async cached<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const value = await loader();
    for (const [cacheKey, entry] of this.cache)
      if (entry.expiresAt <= Date.now()) this.cache.delete(cacheKey);
    while (this.cache.size >= MAX_CACHE_ENTRIES)
      this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { expiresAt: Date.now() + ttl, value });
    return value;
  }

  private async json(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { 'user-agent': 'tuanzi-stock-market/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch {
      throw new BadGatewayException('上游行情服务暂时不可用');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getQuotesBySecids(definitions: string[][]) {
    const url = `${QUOTE_HOST}/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f13,f14,f124&secids=${definitions.map((x) => x[1]).join(',')}`;
    const data = (await this.json(url)) as { data?: { diff?: Array<Record<string, unknown>> } };
    const rows = data.data?.diff ?? [];
    if (rows.length !== definitions.length)
      throw new BadGatewayException('行情源未返回全部大盘指数');
    const bySecid = new Map(
      rows.map((row) => [`${Number(row.f13)}.${String(row.f12).padStart(6, '0')}`, row]),
    );
    const items = definitions.map(([code, secid]) => {
      const row = bySecid.get(secid);
      if (!row) throw new BadGatewayException('大盘指数标识无效');
      const price = Number(row.f2);
      const change = Number(row.f3);
      const changeAmount = Number(row.f4);
      if (price <= 0 || !Number.isFinite(change) || !Number.isFinite(changeAmount))
        throw new BadGatewayException('大盘指数行情内容无效');
      return {
        code,
        name: String(row.f14),
        price,
        change,
        changeAmount,
        source: SOURCE,
        asOf: Number(row.f124) > 0 ? new Date(Number(row.f124) * 1000).toISOString() : null,
      };
    });
    return {
      items,
      source: SOURCE,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async tencentBars(
    code: string,
    period: 'day' | 'week',
    adjustment: PriceAdjustment,
    limit: number,
  ): Promise<MarketBar[]> {
    const symbol =
      code.startsWith('sh') || code.startsWith('sz')
        ? code
        : `${code.startsWith('6') ? 'sh' : 'sz'}${code}`;
    const key = `${adjustment === 'none' ? '' : adjustment}${period}`;
    const path = adjustment === 'none' ? 'kline/kline' : 'fqkline/get';
    const suffix = adjustment === 'none' ? '' : `,${adjustment}`;
    const url = `${TENCENT_HOST}/appstock/app/${path}?param=${encodeURIComponent(`${symbol},${period},,,${Math.min(limit, 600)}${suffix}`)}`;
    const data = (await this.json(url)) as {
      code?: number;
      data?: Record<string, Record<string, unknown>>;
    };
    const rows = data.data?.[symbol]?.[key];
    if (data.code !== 0 || !Array.isArray(rows))
      throw new BadGatewayException('腾讯备用行情源未返回有效 K 线');
    return this.normalizeBars(
      rows.map((row) => (row as unknown[]).slice(0, 6).join(',')),
      period,
    );
  }

  private async minuteBars(code: string, limit: number) {
    const url = `${HISTORY_HOST}/api/qt/stock/trends2/get?secid=${this.secid(code)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0`;
    const data = (await this.json(url)) as { data?: { trends?: string[] } };
    const rows = (data.data?.trends ?? []).map((line) => {
      const [time, open, close, high, low, volume] = line.split(',');
      return {
        time,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
        complete: this.isComplete(time, 'minute'),
      };
    });
    const invalid = rows.some(
      (bar, index) =>
        !bar.time ||
        [bar.open, bar.high, bar.low, bar.close, bar.volume].some(
          (value) => !Number.isFinite(value),
        ) ||
        bar.open < 0 ||
        bar.close <= 0 ||
        bar.low <= 0 ||
        bar.high < Math.max(bar.close, bar.low) ||
        bar.low > Math.min(bar.close, bar.high) ||
        bar.volume < 0 ||
        (index > 0 && rows[index - 1].time >= bar.time),
    );
    if (invalid) throw new BadGatewayException('上游分钟 K 线顺序或内容无效');
    const items = rows.filter((bar) => bar.complete).slice(-Math.min(limit, 1205));
    if (!items.length) throw new BadGatewayException('行情源未返回有效分钟 K 线');
    const indicators = IndicatorEngine.calculate(items, {
      ma: [5, 10, 20, 60],
      macd: [{ fast: 12, slow: 26, signal: 9 }],
      kdj: [{ period: 9, k: 3, d: 3 }],
      rsi: [6, 12, 24],
      boll: [{ period: 20, multiplier: 2 }],
    });
    return {
      code,
      period: 'minute' as const,
      adjustment: 'none' as const,
      source: 'eastmoney-trends',
      fetchedAt: new Date().toISOString(),
      items,
      indicators,
      ...(items.length < limit
        ? { dataGap: `eastmoney-trends 仅返回 ${items.length}/${limit} 根 K 线` }
        : {}),
    };
  }

  private normalizeBars(lines: string[], period: MarketPeriod): MarketBar[] {
    const bars = lines.map((line) => {
      const [time, open, close, high, low, volume] = line.split(',');
      return {
        time,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
        complete: this.isComplete(time, period),
      };
    });
    const invalid = bars.some(
      (bar, index) =>
        !bar.time ||
        [bar.open, bar.high, bar.low, bar.close, bar.volume].some(
          (value) => !Number.isFinite(value),
        ) ||
        bar.open <= 0 ||
        bar.close <= 0 ||
        bar.low <= 0 ||
        bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close, bar.high) ||
        bar.volume < 0 ||
        (index > 0 && bars[index - 1].time >= bar.time),
    );
    if (invalid) throw new BadGatewayException('上游 K 线顺序或内容无效');
    return bars.filter((bar) => bar.complete);
  }

  private secid(code: string): string {
    return `${code.startsWith('6') || code.startsWith('68') ? 1 : 0}.${code}`;
  }
  private market(code: string): 'sh' | 'sz' | 'bj' {
    return code.startsWith('6') ? 'sh' : /^(?:4|8|920)/.test(code) ? 'bj' : 'sz';
  }
  private isComplete(time: string, period: MarketPeriod): boolean {
    const now = new Date();
    const china = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    if (period === 'minute')
      return new Date(time.replace(' ', 'T')).getTime() + 60_000 <= china.getTime();
    const today = `${china.getFullYear()}-${String(china.getMonth() + 1).padStart(2, '0')}-${String(china.getDate()).padStart(2, '0')}`;
    if (period === 'day')
      return (
        time < today ||
        (time === today &&
          (china.getHours() > 15 || (china.getHours() === 15 && china.getMinutes() >= 1)))
      );
    const monday = new Date(china);
    monday.setDate(china.getDate() - ((china.getDay() + 6) % 7));
    const weekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const barDate = new Date(`${time.slice(0, 10)}T00:00:00`);
    const barMonday = new Date(barDate);
    barMonday.setDate(barDate.getDate() - ((barDate.getDay() + 6) % 7));
    const barWeekStart = `${barMonday.getFullYear()}-${String(barMonday.getMonth() + 1).padStart(2, '0')}-${String(barMonday.getDate()).padStart(2, '0')}`;
    return (
      barWeekStart < weekStart ||
      (barWeekStart === weekStart &&
        (china.getDay() === 0 ||
          china.getDay() === 6 ||
          (china.getDay() === 5 &&
            (china.getHours() > 15 || (china.getHours() === 15 && china.getMinutes() >= 1)))))
    );
  }
}
