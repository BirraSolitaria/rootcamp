import { registerActivity } from './streak.js';
import type { DateKey, Streak } from './types.js';
import { DAILY_GOAL, goalJustReached } from './xp.js';

/** What a lesson/review reward changes; the caller applies it in one transaction. */
export interface RewardDelta {
  /** XP granted by this reward. */
  xp: number;
  streak: Streak;
  /** XP earned today including this reward. */
  xpToday: number;
  goalJustReached: boolean;
  streakIncreased: boolean;
}

/**
 * Shared lesson/review reward (§7.2, §7.4): credits `xp` and activity to `today`.
 * `xpToday` is today's XP before this reward; `today` comes from `toDateKey(now, tz)`.
 */
export function grantReward(i: {
  streak: Streak;
  xpToday: number;
  xp: number;
  today: DateKey;
}): RewardDelta {
  const after = i.xpToday + i.xp;
  const streak = registerActivity(i.streak, i.today);
  return {
    xp: i.xp,
    streak,
    xpToday: after,
    goalJustReached: goalJustReached(i.xpToday, after, DAILY_GOAL),
    streakIncreased: streak.current > i.streak.current,
  };
}
