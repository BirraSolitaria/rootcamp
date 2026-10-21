import type { MeDto, PatchMeBody } from '@rootcamp/api-contract';
import { hearts, streaks, users, xpEvents, type Db } from '@rootcamp/db';
import {
  checkStreakBroken,
  computeRank,
  isValidTimeZone,
  maxRank,
  msToNextHeart,
  nextRankProgress,
  regen,
  toDateKey,
} from '@rootcamp/logic';
import { and, eq, sum } from 'drizzle-orm';
import { HttpError } from '../plugins/errors.js';
import type { ContentStore } from './contentStore.js';
import { issueEmailToken } from './emailTokens.js';
import { completedLessonIds } from './progress.js';
import { takenCode, toUserDto, type User } from './users.js';

/** Daily XP goal shown on the home screen (spec §5.1: `dailyGoal: 30`). */
export const DAILY_GOAL = 30;

/**
 * State for `GET /api/me`. In one transaction locks the user's `hearts` and `streaks` rows,
 * applies `regen` and `checkStreakBroken` (today in the user's zone) and stores the result, then
 * sums today's `xp_events`. Completed tracks for the rank come from `content` (0 without it).
 */
export async function getMe(
  db: Db,
  userId: string,
  now: number,
  content: ContentStore | null = null,
): Promise<MeDto> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new HttpError(401, 'unauthorized', 'sign in required');
    const today = toDateKey(now, user.tz);

    const [h] = await tx.select().from(hearts).where(eq(hearts.userId, userId)).for('update');
    const [s] = await tx.select().from(streaks).where(eq(streaks.userId, userId)).for('update');
    if (!h || !s) throw new Error(`user ${userId} has no hearts/streaks row`);

    const before = { count: h.count, lastRegenAt: h.lastRegenAt.getTime() };
    const heartsNow = regen(before, now);
    if (heartsNow.count !== before.count || heartsNow.lastRegenAt !== before.lastRegenAt) {
      await tx
        .update(hearts)
        .set({ count: heartsNow.count, lastRegenAt: new Date(heartsNow.lastRegenAt) })
        .where(eq(hearts.userId, userId));
    }

    const streak = checkStreakBroken(
      { current: s.current, best: s.best, lastActivityDate: s.lastActivityDate },
      today,
    );
    if (streak.current !== s.current) {
      await tx.update(streaks).set({ current: streak.current }).where(eq(streaks.userId, userId));
    }

    const [xp] = await tx
      .select({ total: sum(xpEvents.amount) })
      .from(xpEvents)
      .where(and(eq(xpEvents.userId, userId), eq(xpEvents.day, today)));

    const completedTracks = content
      ? content.completedTrackCount(new Set(await completedLessonIds(tx, content, userId)))
      : 0;
    return {
      user: toUserDto(user),
      hearts: { count: heartsNow.count, msToNext: msToNextHeart(heartsNow, now) },
      streak: { current: streak.current, best: streak.best },
      xpToday: Number(xp?.total ?? 0),
      dailyGoal: DAILY_GOAL,
      // The stored rank never drops; the computed one covers XP not yet reflected in it.
      rank: maxRank(user.rank, computeRank(user.totalXp, completedTracks)),
      nextRank: nextRankProgress(user.totalXp, completedTracks),
    };
  });
}

export interface MeUpdate {
  user: User;
  /** Set when the email changed: plain verify token for the letter to the new address. */
  verifyToken?: string;
}

/**
 * `PATCH /api/me`. `email` may change only while unconfirmed (`409 email_already_verified`
 * otherwise); a change revokes the old `verify` links and issues a new one. Unknown tz →
 * `400 validation`; an address used by someone else → `409 email_taken`.
 */
export async function updateMe(
  db: Db,
  userId: string,
  patch: PatchMeBody,
  now: number,
): Promise<MeUpdate> {
  if (patch.tz !== undefined && !isValidTimeZone(patch.tz)) {
    throw new HttpError(400, 'validation', 'tz: unknown time zone');
  }
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new HttpError(401, 'unauthorized', 'sign in required');
      if (patch.email !== undefined && user.emailVerifiedAt !== null) {
        throw new HttpError(409, 'email_already_verified', 'a confirmed email cannot be changed');
      }

      const set: Partial<typeof users.$inferInsert> = {};
      if (patch.tz !== undefined) set.tz = patch.tz;
      if (patch.reminderEnabled !== undefined) set.reminderEnabled = patch.reminderEnabled;
      if (patch.reminderTime !== undefined) set.reminderTime = patch.reminderTime;
      if (patch.email !== undefined) set.email = patch.email.toLowerCase();
      if (Object.keys(set).length === 0) return { user };

      const [updated] = await tx.update(users).set(set).where(eq(users.id, userId)).returning();
      if (patch.email === undefined) return { user: updated! };
      const verifyToken = await issueEmailToken(tx, userId, 'verify', now);
      return { user: updated!, verifyToken };
    });
  } catch (err) {
    if (takenCode(err) === 'email_taken') throw new HttpError(409, 'email_taken', 'email is taken');
    throw err;
  }
}
