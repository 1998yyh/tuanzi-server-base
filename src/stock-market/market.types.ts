export type MarketPeriod = 'day' | 'week' | 'minute';
export type PriceAdjustment = 'none' | 'qfq' | 'hfq';

export interface MarketBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  complete: boolean;
}

export interface MacdValue {
  dif: number;
  dea: number;
  histogram: number;
}

export interface IndicatorRow {
  ma: Record<string, number | null>;
  macd: Record<string, MacdValue | null>;
  kdj: Record<string, { k: number; d: number; j: number } | null>;
  rsi: Record<string, number | null>;
  boll: Record<string, { middle: number; upper: number; lower: number } | null>;
}

export interface IndicatorRequest {
  ma?: number[];
  macd?: Array<{ fast: number; slow: number; signal: number }>;
  kdj?: Array<{ period: number; k: number; d: number }>;
  rsi?: number[];
  boll?: Array<{ period: number; multiplier: number }>;
}
