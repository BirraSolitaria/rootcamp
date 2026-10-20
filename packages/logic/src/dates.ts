import type { DateKey } from './types.js';

const DAY_MS = 86_400_000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function parseKey(key: DateKey): [number, number, number] {
  const [y = NaN, m = NaN, d = NaN] = key.split('-').map(Number);
  return [y, m, d];
}

function utcDayMs(key: DateKey): number {
  const [y, m, d] = parseKey(key);
  return Date.UTC(y, m - 1, d);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached formatter giving wall-clock parts of an instant in `tz`. */
function wallClock(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

function partsOf(
  ms: number,
  tz: string,
): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of wallClock(tz).formatToParts(ms)) {
    if (p.type in out) out[p.type as keyof typeof out] = Number(p.value);
  }
  return out;
}

/** Offset of `tz` from UTC at instant `ms`, in ms (e.g. +3h for Europe/Moscow). */
function tzOffset(ms: number, tz: string): number {
  const p = partsOf(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** Calendar day of instant `ms` in IANA zone `tz` as "YYYY-MM-DD". */
export function toDateKey(ms: number, tz: string): DateKey {
  const p = partsOf(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
}

/** b − a in whole days; independent of DST. */
export function diffDays(a: DateKey, b: DateKey): number {
  return Math.round((utcDayMs(b) - utcDayMs(a)) / DAY_MS);
}

export function addDays(key: DateKey, n: number): DateKey {
  const date = new Date(utcDayMs(key) + n * DAY_MS);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

/**
 * Epoch ms of wall-clock time hour:minute on day `key` in IANA zone `tz`.
 * A time skipped by a spring-forward transition is shifted forward by the gap;
 * an ambiguous fall-back time resolves to its first (daylight) occurrence.
 */
export function localTimeOn(key: DateKey, hour: number, minute: number, tz: string): number {
  const [y, m, d] = parseKey(key);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const guessOffset = tzOffset(wall, tz);
  const first = wall - guessOffset;
  const firstOffset = tzOffset(first, tz);
  if (firstOffset === guessOffset) return first;
  // Offset changed between the guess and the result: retry once with the new offset.
  const second = wall - firstOffset;
  if (tzOffset(second, tz) === firstOffset) return second;
  // The retry lands on yet another offset: the wall time falls in a DST gap.
  // Of the two candidates, the later one is after the gap (shifted forward) in any zone.
  return Math.max(first, second);
}

export function isDateKey(x: unknown): x is DateKey {
  return typeof x === 'string' && DATE_KEY_RE.test(x);
}

/** True when `tz` is an IANA zone known to the runtime's Intl data. */
export function isValidTimeZone(tz: string): boolean {
  if (tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
