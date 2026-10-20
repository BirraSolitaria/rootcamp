import { diffDays } from './dates.js';
import type { DateKey, Streak } from './types.js';

/** §7.2: call on completing a lesson (incl. replay) or a review/practice session. */
export function registerActivity(s: Streak, today: DateKey): Streak {
  let current: number;
  if (s.lastActivityDate === null) {
    current = 1;
  } else {
    const d = diffDays(s.lastActivityDate, today);
    if (d <= 0) return s; // same day or clock moved back
    current = d === 1 ? s.current + 1 : 1;
  }
  return { current, best: Math.max(s.best, current), lastActivityDate: today };
}

/** §7.2: called when reading state; zeroes `current` after a missed day, keeps best and lastActivityDate. */
export function checkStreakBroken(s: Streak, today: DateKey): Streak {
  if (s.lastActivityDate !== null && s.current !== 0 && diffDays(s.lastActivityDate, today) >= 2) {
    return { ...s, current: 0 };
  }
  return s;
}
