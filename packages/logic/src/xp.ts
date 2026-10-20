import { lastNDays, weekdayLabel } from './format.js';
import type { DateKey } from './types.js';

export const LESSON_XP = 10;
export const PERFECT_BONUS = 5;
/** XP per day to meet the daily goal (fixed; the 20/30/50 choice was dropped). */
export const DAILY_GOAL = 30;

export function lessonXp(mistakes: number): number {
  return mistakes === 0 ? LESSON_XP + PERFECT_BONUS : LESSON_XP;
}

export function goalJustReached(before: number, after: number, goal: number): boolean {
  return before < goal && after >= goal;
}

/** Last 7 days oldest→today; ratio = xp / max(goal, max xp of the 7). */
export function weekBars(
  xpByDate: Record<DateKey, number>,
  today: DateKey,
  goal: number,
): { key: DateKey; label: string; xp: number; ratio: number }[] {
  const days = lastNDays(today, 7).map((key) => ({
    key,
    label: weekdayLabel(key),
    xp: xpByDate[key] ?? 0,
  }));
  const scale = Math.max(goal, ...days.map((d) => d.xp));
  return days.map((d) => ({ ...d, ratio: scale > 0 ? d.xp / scale : 0 }));
}
