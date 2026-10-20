// `email` queue worker (spec §9): sends a letter recorded in `email_log`, journals the outcome and
// schedules its own retries. pg-boss's built-in retry is off (`retryLimit: 0`): the ladder below
// is not exponential, and the journal must count attempts itself. A periodic sweep reconciles
// rows the happy path lost track of.
import { emailLog } from '@rootcamp/db';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import type { Executor } from '../services/executor.js';
import {
  attemptDelivery,
  EMAIL_QUEUE,
  markFailed,
  markSent,
  releaseForRetry,
  type EmailQueue,
  type MailLog,
  type Mailer,
} from '../services/mailer.js';
import { BOSS_SCHEMA } from './boss.js';

export { EMAIL_QUEUE } from '../services/mailer.js';

/**
 * Delays (minutes) before retries 1..5: the first send is immediate, then 5 retries
 * (spec §9 "5 попыток (1, 5, 15, 60, 240 мин)"). The delay after attempt `n` is index `n-1`.
 */
export const RETRY_DELAYS_MIN = [1, 5, 15, 60, 240] as const;

/** First send plus every retry; reaching it marks the row `failed`. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;

/**
 * A claim older than this means the worker died (or could not write) between claiming and
 * journalling. Far above one SMTP attempt (5 s timeouts per phase).
 */
export const CLAIM_LEASE_MS = 10 * 60_000;

/**
 * A `queued`, unclaimed row whose attempt was due this long ago and that has no pending or
 * active job lost its job: the sweep re-queues it. Longer than pg-boss job expiry (15 min).
 */
export const SWEEP_GRACE_MS = 20 * 60_000;

/** How often the running api sweeps `email_log`. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

export interface EmailJobData {
  logId: number;
}

export interface EmailWorkerDeps {
  db: Executor;
  mailer: Mailer;
  /** Where retries go (the running pg-boss instance). */
  queue: EmailQueue;
  now: () => number;
  log?: MailLog;
}

/**
 * `stalled`: the outcome could not be fully written (retry job not queued, or nothing could be
 * journalled); the row is left for the sweep.
 */
export type EmailJobOutcome = 'sent' | 'retry' | 'failed' | 'skipped' | 'stalled';

/** Handles one `email` job. Never rejects for delivery problems; they are journalled and logged. */
export async function handleEmailJob(
  deps: EmailWorkerDeps,
  job: { data: EmailJobData },
): Promise<EmailJobOutcome> {
  const { db, log } = deps;
  const logId = job.data.logId;
  const attempt = await attemptDelivery(db, deps.mailer, logId, new Date(deps.now()));

  if (attempt.outcome === 'skipped') return 'skipped';

  if (attempt.outcome === 'delivered') {
    // On false the row stays claimed; the sweep closes it as "outcome unknown", never resends.
    return (await markSent(db, logId, new Date(deps.now()), log)) ? 'sent' : 'stalled';
  }

  const { attempts, error } = attempt;
  if (!attempt.permanent && attempts < MAX_ATTEMPTS) {
    const startAfter = RETRY_DELAYS_MIN[attempts - 1]! * 60;
    try {
      await releaseForRetry(db, logId, error, new Date(deps.now() + startAfter * 1000));
    } catch (err) {
      log?.error({ err, emailLogId: logId }, 'email failure could not be recorded');
      return 'stalled';
    }
    try {
      await deps.queue.send(EMAIL_QUEUE, { logId }, { retryLimit: 0, startAfter });
    } catch (err) {
      log?.error({ err, emailLogId: logId }, 'email retry could not be queued; left to the sweep');
      return 'stalled';
    }
    log?.warn({ err: error, emailLogId: logId, attempts, startAfter }, 'email failed, retrying');
    return 'retry';
  }

  try {
    await markFailed(db, logId, error);
  } catch (err) {
    log?.error({ err, emailLogId: logId }, 'email failure could not be recorded');
    return 'stalled';
  }
  log?.error({ err: error, emailLogId: logId, attempts }, 'email delivery failed for good');
  return 'failed';
}

export interface SweepResult {
  /** Rows given a new job. */
  requeued: number[];
  /** Rows closed as `failed` because their claim expired (delivery outcome unknown). */
  abandoned: number[];
}

/**
 * Reconciles `email_log` with the queue:
 * - a claim older than `CLAIM_LEASE_MS` → `failed` ("outcome unknown"). The letter may already
 *   have gone out, so it is never resent automatically; `failed` is what admins are alerted on;
 * - an unclaimed `queued` row due more than `SWEEP_GRACE_MS` ago with no `created`/`retry`/
 *   `active` job → a new job (its due time moves to now, so it is not re-queued again soon).
 * Safe to run concurrently (several replicas): the claim guard keeps duplicates from sending.
 */
export async function sweepEmailLog(deps: EmailWorkerDeps): Promise<SweepResult> {
  const { db, now } = deps;
  const at = new Date(now());

  const abandoned = await db
    .update(emailLog)
    .set({
      status: 'failed',
      lastError: 'delivery interrupted; outcome unknown',
      claimedAt: null,
      subject: null,
      textBody: null,
      htmlBody: null,
    })
    .where(
      and(
        eq(emailLog.status, 'queued'),
        isNotNull(emailLog.claimedAt),
        lt(emailLog.claimedAt, new Date(at.getTime() - CLAIM_LEASE_MS)),
      ),
    )
    .returning({ id: emailLog.id });

  const jobs = sql.raw(`"${BOSS_SCHEMA}"."job"`);
  const lost = await db
    .update(emailLog)
    .set({ nextAttemptAt: at })
    .where(
      and(
        eq(emailLog.status, 'queued'),
        isNull(emailLog.claimedAt),
        // Raw SQL bypasses the column's Date mapping: bind an ISO string.
        sql`coalesce(${emailLog.nextAttemptAt}, ${emailLog.createdAt})
          < ${new Date(at.getTime() - SWEEP_GRACE_MS).toISOString()}::timestamptz`,
        sql`not exists (
          select 1 from ${jobs} j
          where j.name = ${EMAIL_QUEUE}
            and j.state in ('created', 'retry', 'active')
            and j.data->>'logId' = ${emailLog.id}::text)`,
      ),
    )
    .returning({ id: emailLog.id });

  const requeued: number[] = [];
  for (const { id } of lost) {
    try {
      await deps.queue.send(EMAIL_QUEUE, { logId: id }, { retryLimit: 0 });
      requeued.push(id);
    } catch (err) {
      deps.log?.error({ err, emailLogId: id }, 'sweep could not re-queue email');
    }
  }
  for (const { id } of abandoned) {
    deps.log?.error({ emailLogId: id }, 'email delivery interrupted; marked failed');
  }
  return {
    requeued: requeued.sort((a, b) => a - b),
    abandoned: abandoned.map((r) => r.id).sort((a, b) => a - b),
  };
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

/** Sweeps now and then every `intervalMs`; returns a function that stops the timer. */
export function startEmailSweeper(
  deps: EmailWorkerDeps,
  intervalMs: number = SWEEP_INTERVAL_MS,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepEmailLog(deps);
    } catch (err) {
      deps.log?.error({ err }, 'email sweep failed');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
