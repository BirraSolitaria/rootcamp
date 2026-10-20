import type { LimitOverride, Limits } from '../types.js';

export interface LimitSpec {
  max: number;
  windowMs: number;
}

export interface Limiter {
  /** Records a hit for `key` at `now` and returns true, or returns false when over the limit. */
  hit(key: string, now: number): boolean;
  /** Milliseconds until a hit for `key` would be allowed; 0 when it would be allowed at `now`. */
  retryAfterMs(key: string, now: number): number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Production values of the per-key limits (spec §5.1, §6.3). `deps.limits` may override them. */
export const LIMITS = {
  /** Every API request except `/api/health`: per signed-in user, else per client IP. */
  api: { max: 300, windowMs: MINUTE_MS },
  /** `POST /api/auth/login`: 5/min per IP… */
  loginIp: { max: 5, windowMs: MINUTE_MS },
  /** …and 20/h per (lowercased) email, counted before the credentials are checked. */
  loginEmail: { max: 20, windowMs: HOUR_MS },
  /** `POST /api/auth/register`: 3/h per IP, counted before any parsing or hashing. */
  registerIp: { max: 3, windowMs: HOUR_MS },
  /** `POST /api/auth/forgot`: 3/h per IP. */
  forgotIp: { max: 3, windowMs: HOUR_MS },
  /**
   * `POST /api/auth/reset`: 10/h per IP, counted before the body is read. Not in the spec;
   * chosen in the M2 final review to cap argon2 work per IP while leaving room for retyping.
   */
  resetIp: { max: 10, windowMs: HOUR_MS },
  /**
   * `POST /api/me/password` (guesses of `current` from a stolen session): 5/min and 20/h per
   * user. Not in the spec; chosen in Task 7 to match the login budget.
   */
  changePasswordMinute: { max: 5, windowMs: MINUTE_MS },
  changePasswordHour: { max: 20, windowMs: HOUR_MS },
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
    retryAfterMs(key, now) {
      const list = prune(hits.get(key) ?? [], now);
      if (list.length < max) return 0;
      // The hit that has to leave the window before another one fits.
      return list[list.length - max]! + windowMs - now;
    },
  };
}

/**
 * All of `limiters` at once: a hit is recorded in every one of them or in none (so a request
 * refused by the hourly budget does not also eat into the per-minute one).
 */
export function allOf(...limiters: Limiter[]): Limiter {
  const retryAfterMs = (key: string, now: number) =>
    Math.max(0, ...limiters.map((l) => l.retryAfterMs(key, now)));
  return {
    hit(key, now) {
      if (retryAfterMs(key, now) > 0) return false;
      for (const l of limiters) l.hit(key, now);
      return true;
    },
    retryAfterMs,
  };
}

/** Every limiter of one app instance, built from `LIMITS` with `deps.limits` overrides. */
export interface Limiters {
  /** Global: key `u:<userId>` or `ip:<ip>`. */
  api: Limiter;
  loginIp: Limiter;
  /** Key: the lowercased email. */
  loginEmail: Limiter;
  registerIp: Limiter;
  forgotIp: Limiter;
  resetIp: Limiter;
  /** Key: userId. */
  changePassword: Limiter;
  /**
   * One per-user budget for verify letters (resend-verification and `PATCH /api/me {email}`):
   * 1/min and 5/day, shared so an email change cannot bypass the resend limit.
   */
  verifyLetters: Limiter;
}

export function createLimiters(overrides?: Limits): Limiters {
  const one = (name: LimitName) => createLimiter(limitSpec(name, overrides));
  return {
    api: one('api'),
    loginIp: one('loginIp'),
    loginEmail: one('loginEmail'),
    registerIp: one('registerIp'),
    forgotIp: one('forgotIp'),
    resetIp: one('resetIp'),
    changePassword: allOf(one('changePasswordMinute'), one('changePasswordHour')),
    verifyLetters: allOf(one('resendVerificationMinute'), one('resendVerificationDay')),
  };
}
