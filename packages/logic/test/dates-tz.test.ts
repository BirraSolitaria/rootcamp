import { describe, expect, it } from 'vitest';
import { isValidTimeZone, localTimeOn, toDateKey } from '../src/dates.js';
import { grantReward } from '../src/reward.js';

describe('toDateKey in an explicit IANA zone', () => {
  it('Vladivostok (UTC+10) is already on the next day', () => {
    expect(toDateKey(Date.UTC(2026, 9, 20, 15, 30), 'Asia/Vladivostok')).toBe('2026-10-21');
  });
  it('Moscow (UTC+3) flips at 21:00 UTC', () => {
    expect(toDateKey(Date.UTC(2026, 9, 20, 20, 59), 'Europe/Moscow')).toBe('2026-10-20');
    expect(toDateKey(Date.UTC(2026, 9, 20, 21, 0), 'Europe/Moscow')).toBe('2026-10-21');
  });
  it('does not depend on the process TZ', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(toDateKey(Date.UTC(2026, 9, 20, 23, 0), 'UTC')).toBe('2026-10-20');
    expect(toDateKey(Date.UTC(2026, 9, 20, 23, 0), 'Asia/Tokyo')).toBe('2026-10-21');
  });
});

describe('localTimeOn across DST', () => {
  it('nonexistent 02:30 on spring-forward day stays on that day (shifted forward)', () => {
    const t = localTimeOn('2026-03-08', 2, 30, 'America/New_York');
    expect(toDateKey(t, 'America/New_York')).toBe('2026-03-08');
    // DST starts at 07:00 UTC; the shifted instant is not before the gap.
    expect(t).toBeGreaterThanOrEqual(Date.UTC(2026, 2, 8, 7, 0));
  });
  it('evening after fall-back uses standard time', () => {
    expect(localTimeOn('2026-11-01', 20, 0, 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 1, 0));
  });
  it('plain day in a positive-offset zone', () => {
    expect(localTimeOn('2026-10-20', 9, 15, 'Europe/Moscow')).toBe(Date.UTC(2026, 9, 20, 6, 15));
  });
});

describe('isValidTimeZone', () => {
  it('rejects unknown zones and accepts IANA ones', () => {
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
  });
});

describe('grantReward', () => {
  it('adds xp to today, reaches the daily goal and extends the streak', () => {
    const r = grantReward({
      streak: { current: 2, best: 2, lastActivityDate: '2026-10-19' },
      xpToday: 25,
      xp: 15,
      today: '2026-10-20',
    });
    expect(r).toMatchObject({ xp: 15, xpToday: 40, goalJustReached: true, streakIncreased: true });
    expect(r.streak).toEqual({ current: 3, best: 3, lastActivityDate: '2026-10-20' });
  });
  it('second activity the same day: goal already reached, streak unchanged', () => {
    const streak = { current: 3, best: 3, lastActivityDate: '2026-10-20' };
    const r = grantReward({ streak, xpToday: 40, xp: 10, today: '2026-10-20' });
    expect(r).toEqual({
      xp: 10,
      xpToday: 50,
      goalJustReached: false,
      streakIncreased: false,
      streak,
    });
  });
});
