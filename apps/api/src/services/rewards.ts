// XP, rank and «today» bookkeeping shared by lessons, review/drill (Task 6) and practices (M4).
import { users, xpEvents, type XP_SOURCES } from '@rootcamp/db';
import { computeRank, maxRank, toDateKey, type DateKey, type Rank } from '@rootcamp/logic';
import { and, eq, sql, sum } from 'drizzle-orm';
import type { ContentStore } from './contentStore.js';
import type { Executor } from './executor.js';
import { completedLessonIds } from './progress.js';

/** XP the user earned on `day` (a date key in their zone). */
export async function xpOnDay(tx: Executor, userId: string, day: DateKey): Promise<number> {
  const [row] = await tx
    .select({ total: sum(xpEvents.amount) })
    .from(xpEvents)
    .where(and(eq(xpEvents.userId, userId), eq(xpEvents.day, day)));
  return Number(row?.total ?? 0);
}

export interface XpGrant {
  amount: number;
  source: (typeof XP_SOURCES)[number];
  refId: string | null;
  now: number;
  /** Active content: completed tracks count towards the rank. */
  store: ContentStore;
}

/**
 * Credits XP inside the caller's transaction: inserts the `xp_events` row on the user's
 * calendar day of `now`, adds it to `users.total_xp` (the two always move together) and raises
 * the stored rank to `maxRank(saved, computeRank(total, completedTracks))` — it never drops.
 * Call it after the completion it rewards is written, so that completion counts for the rank.
 */
export async function applyXp(
  tx: Executor,
  user: { id: string; tz: string },
  grant: XpGrant,
): Promise<{ xpToday: number; rank: Rank }> {
  const day = toDateKey(grant.now, user.tz);
  await tx.insert(xpEvents).values({
    userId: user.id,
    amount: grant.amount,
    source: grant.source,
    refId: grant.refId,
    day,
    createdAt: new Date(grant.now),
  });
  const [row] = await tx
    .update(users)
    .set({ totalXp: sql`${users.totalXp} + ${grant.amount}` })
    .where(eq(users.id, user.id))
    .returning({ totalXp: users.totalXp, rank: users.rank });
  if (!row) throw new Error(`user ${user.id} not found`);

  const completed = new Set(await completedLessonIds(tx, grant.store, user.id));
  const rank = maxRank(
    row.rank,
    computeRank(row.totalXp, grant.store.completedTrackCount(completed)),
  );
  if (rank !== row.rank) await tx.update(users).set({ rank }).where(eq(users.id, user.id));
  return { xpToday: await xpOnDay(tx, user.id, day), rank };
}
