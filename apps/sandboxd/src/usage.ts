import type { Db } from '@rootcamp/db';
import { sql } from 'drizzle-orm';

const MINUTE_MS = 60_000;

/** Billed minutes of a sandbox: `ceil((stopped - ready) / 60 000)`, never negative. */
export function usageMinutes(readyAt: Date, stoppedAt: Date): number {
  return Math.max(0, Math.ceil((stoppedAt.getTime() - readyAt.getTime()) / MINUTE_MS));
}

export interface UsageRow {
  userId: string | null;
  readyAt: Date | null;
  test: boolean;
}

/**
 * Adds the sandbox's minutes to `sandbox_usage(user_id, day)`, the day taken at `stoppedAt` in
 * the user's zone (`users.tz`). Test sandboxes (no user) and sandboxes that never became
 * `ready` book nothing. Returns the minutes booked.
 */
export async function recordUsage(db: Db, row: UsageRow, stoppedAt: Date): Promise<number> {
  if (!row.userId || row.test || !row.readyAt) return 0;
  const minutes = usageMinutes(row.readyAt, stoppedAt);
  if (minutes <= 0) return 0;
  await db.execute(sql`
    INSERT INTO sandbox_usage (user_id, day, minutes)
    SELECT u.id, (${stoppedAt.toISOString()}::timestamptz AT TIME ZONE u.tz)::date, ${minutes}
    FROM users u WHERE u.id = ${row.userId}
    ON CONFLICT (user_id, day) DO UPDATE SET minutes = sandbox_usage.minutes + excluded.minutes`);
  return minutes;
}
