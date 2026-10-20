// `email` queue worker (spec §9): sends a letter recorded in `email_log`, journals the outcome and
// schedules its own retries. pg-boss's built-in retry is off (`retryLimit: 0`): the ladder below
// is not exponential, and the journal must count attempts itself.
import { emailLog } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type PgBoss from 'pg-boss';
import type { Executor } from '../services/executor.js';
import {
  attemptDelivery,
  EMAIL_QUEUE,
  markSent,
  type EmailQueue,
  type Mailer,
} from '../services/mailer.js';

export { EMAIL_QUEUE } from '../services/mailer.js';

/**
 * Delays (minutes) before retries 1..5: the first send is immediate, then 5 retries
 * (spec §9 "5 попыток (1, 5, 15, 60, 240 мин)"). The delay after attempt `n` is index `n-1`.
 */
export const RETRY_DELAYS_MIN = [1, 5, 15, 60, 240] as const;

/** First send plus every retry; reaching it marks the row `failed`. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;

export interface EmailJobData {
  logId: number;
}

export interface EmailWorkerDeps {
  db: Executor;
  mailer: Mailer;
  /** Where retries go (the running pg-boss instance). */
  queue: EmailQueue;
  now: () => number;
  log?: FastifyBaseLogger;
}

export type EmailJobOutcome = 'sent' | 'retry' | 'failed' | 'skipped';

/**
 * Handles one `email` job. Rejects only on database/queue errors; with `retryLimit: 0` pg-boss
 * then fails the job without re-running it, so a letter that already went out is never resent.
 */
export async function handleEmailJob(
  deps: EmailWorkerDeps,
  job: { data: EmailJobData },
): Promise<EmailJobOutcome> {
  const { db, log } = deps;
  const logId = job.data.logId;
  const attempt = await attemptDelivery(db, deps.mailer, logId);

  if (attempt.outcome === 'skipped') return 'skipped';

  if (attempt.outcome === 'delivered') {
    try {
      await markSent(db, logId, new Date(deps.now()));
    } catch (err) {
      log?.error({ err, emailLogId: logId }, 'email sent but its status was not recorded');
      throw err;
    }
    return 'sent';
  }

  const { attempts, error } = attempt;
  if (!attempt.permanent && attempts < MAX_ATTEMPTS) {
    await db.update(emailLog).set({ lastError: error }).where(eq(emailLog.id, logId));
    const startAfter = RETRY_DELAYS_MIN[attempts - 1]! * 60;
    await deps.queue.send(EMAIL_QUEUE, { logId }, { retryLimit: 0, startAfter });
    log?.warn(
      { err: error, emailLogId: logId, attempts, startAfter },
      'email delivery failed, retrying',
    );
    return 'retry';
  }

  await db
    .update(emailLog)
    .set({ status: 'failed', lastError: error, subject: null, textBody: null, htmlBody: null })
    .where(eq(emailLog.id, logId));
  log?.error({ err: error, emailLogId: logId, attempts }, 'email delivery failed for good');
  return 'failed';
}

/** Starts the `email` worker (one job at a time); returns the worker id for `offWork`. */
export function startEmailWorker(
  boss: PgBoss,
  deps: EmailWorkerDeps,
  options: PgBoss.WorkOptions = {},
): Promise<string> {
  return boss.work<EmailJobData>(EMAIL_QUEUE, { ...options, batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handleEmailJob(deps, job);
  });
}
