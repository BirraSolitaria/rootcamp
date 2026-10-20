import { addDays } from './dates.js';
import type { DateKey } from './types.js';

type Weekday = 'Пн' | 'Вт' | 'Ср' | 'Чт' | 'Пт' | 'Сб' | 'Вс';

// Indexed by Date#getUTCDay(): 0 = Sunday.
const WEEKDAYS: readonly Weekday[] = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** Remaining time as zero-padded "MM:SS"; seconds rounded up. */
export function formatMmSs(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function weekdayLabel(key: DateKey): Weekday {
  const [y = NaN, m = NaN, d = NaN] = key.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as Weekday;
}

/** The n days ending with `today`, oldest first. */
export function lastNDays(today: DateKey, n: number): DateKey[] {
  const out: DateKey[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

/** Stable 6-hex pseudo "layer digest" for a lesson id (decorative, FNV-1a). */
export function layerHash(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 8).toString(16).padStart(6, '0');
}
