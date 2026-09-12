export type AlertField = 'price' | 'change' | 'MA' | 'MACD' | 'KDJ' | 'RSI' | 'BOLL';
export type AlertOperator = 'gte' | 'lte';

export interface AlertCondition {
  field: AlertField;
  operator: AlertOperator;
  threshold: number;
}

export interface AlertObservation {
  value?: number;
  previousValue?: number;
  currentValue?: number;
  lastMatch: boolean | null;
}

export function evaluateAlert(
  condition: AlertCondition,
  observation: AlertObservation,
): { match: boolean; trigger: boolean } | null {
  let match: boolean;
  if (['MA', 'MACD', 'KDJ', 'BOLL'].includes(condition.field)) {
    if (
      observation.previousValue == null ||
      observation.currentValue == null ||
      !Number.isFinite(observation.previousValue) ||
      !Number.isFinite(observation.currentValue)
    )
      return null;
    match =
      condition.operator === 'gte'
        ? observation.previousValue <= 0 && observation.currentValue > 0
        : observation.previousValue >= 0 && observation.currentValue < 0;
    return { match, trigger: match };
  } else {
    if (observation.value == null || !Number.isFinite(observation.value)) return null;
    match =
      condition.operator === 'gte'
        ? observation.value >= condition.threshold
        : observation.value <= condition.threshold;
  }
  return { match, trigger: match && observation.lastMatch !== true };
}

const shanghaiParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
};

export function isFreshQuote(asOf: string | null | undefined, now = new Date()): boolean {
  if (!asOf) return false;
  const observedAt = new Date(asOf);
  if (!Number.isFinite(observedAt.getTime())) return false;
  const age = now.getTime() - observedAt.getTime();
  if (age < -30_000 || age > 5 * 60_000) return false;
  const current = shanghaiParts(now);
  const observed = shanghaiParts(observedAt);
  if (current.year + current.month + current.day !== observed.year + observed.month + observed.day)
    return false;
  if (current.weekday === 'Sat' || current.weekday === 'Sun') return false;
  const minutes = Number(current.hour) * 60 + Number(current.minute);
  return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

function previousWeekday(date: Date): Date {
  const result = new Date(date);
  do result.setUTCDate(result.getUTCDate() - 1);
  while (result.getUTCDay() === 0 || result.getUTCDay() === 6);
  return result;
}

export function isFreshCompletedDayBar(
  bar: { time: string; complete: boolean },
  now = new Date(),
): boolean {
  if (!bar.complete) return false;
  const current = shanghaiParts(now);
  const localDate = new Date(`${current.year}-${current.month}-${current.day}T00:00:00.000Z`);
  const minutes = Number(current.hour) * 60 + Number(current.minute);
  const expected =
    minutes >= 910 && !['Sat', 'Sun'].includes(current.weekday)
      ? localDate
      : previousWeekday(localDate);
  return bar.time.slice(0, 10) === isoDate(expected);
}
