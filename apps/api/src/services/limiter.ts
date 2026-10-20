import type { LimitOverride, Limits } from '../types.js';

export interface LimitSpec {
  max: number;
  windowMs: number;
}

export interface Limiter {
  /** Records a hit for `key` at `now` and returns true, or returns false when over the limit. */
  hit(key: string, now: number): boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 3600_000;

/** Production values of the per-key limits (spec §5.1, §6.3). `deps.limits` may override them. */
export const LIMITS = {
  /** `POST /api/auth/resend-verification`: once a minute per user… */
  resendVerificationMinute: { max: 1, windowMs: MINUTE_MS },
  /** …and five times a day per user. */
  resendVerificationDay: { max: 5, windowMs: DAY_MS },
} as const satisfies Record<string, LimitSpec>;

export type LimitName = keyof typeof LIMITS;

/** The production value of `name` with any override from `deps.limits` applied. */
export function limitSpec(name: LimitName, overrides?: Limits): LimitSpec {
  const o: LimitOverride = overrides?.[name] ?? {};
  return { max: o.max ?? LIMITS[name].max, windowMs: o.windowMs ?? LIMITS[name].windowMs };
}

/** Sweep idle keys after this many hits so the map does not grow without bound. */
const SWEEP_EVERY = 1000;

/**
 * In-memory sliding-window log: a hit at `now` is allowed when fewer than `max` allowed hits
 * happened in `(now - windowMs, now]`. Rejected hits are not recorded. State lives in the
 * instance, so create limiters per app (a rebuilt app starts with clean counters).
 */
export function createLimiter({ max, windowMs }: LimitSpec): Limiter {
  const hits = new Map<string, number[]>();
  let sinceSweep = 0;

  function prune(list: number[], now: number): number[] {
    const cutoff = now - windowMs;
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    return i === 0 ? list : list.slice(i);
  }

  function sweep(now: number): void {
    for (const [key, list] of hits) {
      const kept = prune(list, now);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }

  return {
    hit(key, now) {
      if (++sinceSweep >= SWEEP_EVERY) {
        sinceSweep = 0;
        sweep(now);
      }
      const list = prune(hits.get(key) ?? [], now);
      hits.set(key, list);
      if (list.length >= max) return false;
      list.push(now);
      return true;
    },
  };
}

/**
 * One per-user budget for verify letters (resend-verification and `PATCH /api/me {email}`):
 * 1/min and 5/day. Create one per app and share it between the routes that send them.
 */
export function createVerifyLetterLimiter(overrides?: Limits): Limiter {
  const minute = createLimiter(limitSpec('resendVerificationMinute', overrides));
  const day = createLimiter(limitSpec('resendVerificationDay', overrides));
  return { hit: (key, now) => minute.hit(key, now) && day.hit(key, now) };
}
