import type { FastifyBaseLogger } from 'fastify';
import PgBoss from 'pg-boss';
import type { Config } from '../config.js';
import { EMAIL_QUEUE } from '../services/mailer.js';
import { RUNS_SYNC_QUEUE, STOP_SOLVED_QUEUE } from '../services/runs.js';

/** pg-boss keeps its tables in this schema of the app database. */
export const BOSS_SCHEMA = 'pgboss';

/**
 * Starts pg-boss on `DATABASE_URL` (own small `pg` pool, schema `pgboss`, created/migrated by
 * pg-boss itself) and ensures the `email` queue exists with built-in retry off — the email job
 * runs its own retry ladder (`jobs/email.ts`).
 */
export async function startBoss(
  config: Pick<Config, 'DATABASE_URL'>,
  log: Pick<FastifyBaseLogger, 'error'>,
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: BOSS_SCHEMA,
    max: 4,
    retryLimit: 0,
  });
  // Without a listener an 'error' event (e.g. a lost connection in maintenance) would crash.
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();
  await boss.createQueue(EMAIL_QUEUE, { name: EMAIL_QUEUE, retryLimit: 0 });
  // Practice jobs (M4a): runs-sync is cron-driven, stop-solved retries a failed DELETE.
  await boss.createQueue(RUNS_SYNC_QUEUE, { name: RUNS_SYNC_QUEUE, retryLimit: 0 });
  await boss.createQueue(STOP_SOLVED_QUEUE, {
    name: STOP_SOLVED_QUEUE,
    retryLimit: 3,
    retryDelay: 30,
  });
  return boss;
}
