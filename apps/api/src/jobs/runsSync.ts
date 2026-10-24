// `runs-sync` (plan M4a Task 7): once a minute every unfinished practice run is brought in line
// with its sandbox, so runs end (`expired`, `failed`, `queue_timeout`, …) even when nobody polls
// `GET /api/runs/:id`. Reads are passive: they never keep an idle sandbox alive. pg-boss's cron
// fires it on one replica per minute. Without sandboxd it does nothing.
import type PgBoss from 'pg-boss';
import { RUNS_SYNC_QUEUE, type RunSync } from '../services/runs.js';

export { RUNS_SYNC_QUEUE } from '../services/runs.js';

/** Every minute (pg-boss cron). */
export const RUNS_SYNC_CRON = '* * * * *';

/** Schedules the job and starts its worker; returns the worker id for `offWork`. */
export async function startRunsSync(
  boss: PgBoss,
  sync: Pick<RunSync, 'syncOpenRuns'>,
): Promise<string> {
  await boss.schedule(RUNS_SYNC_QUEUE, RUNS_SYNC_CRON, {}, { retryLimit: 0 });
  return boss.work(RUNS_SYNC_QUEUE, { batchSize: 1 }, async () => {
    await sync.syncOpenRuns();
  });
}
