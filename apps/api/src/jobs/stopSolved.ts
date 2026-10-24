// `stop-solved` (spec §6.2 step 9): queued by `check` with `startAfter: 120` once a run is solved,
// so the user sees the result before the sandbox goes; calls sandboxd DELETE with reason
// `solved` (idempotent; an unknown sandbox is already gone). pg-boss retries a failed call.
// Without sandboxd it does nothing.
import type PgBoss from 'pg-boss';
import { STOP_SOLVED_QUEUE, type RunSync, type StopSolvedJob } from '../services/runs.js';

export { STOP_SOLVED_QUEUE, type StopSolvedJob } from '../services/runs.js';

/** Starts the worker; returns its id for `offWork`. */
export function startStopSolvedWorker(
  boss: PgBoss,
  sync: Pick<RunSync, 'stopSolved'>,
): Promise<string> {
  return boss.work<StopSolvedJob>(STOP_SOLVED_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await sync.stopSolved(job.data);
  });
}
