import { emailLog } from '@rootcamp/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';
import type PgBoss from 'pg-boss';
import type { Config } from '../config.js';
import type { MailMessage, Mailer } from '../types.js';
import type { Executor } from './executor.js';
import { setSetting } from './settings.js';

export type { MailMessage, Mailer } from '../types.js';

type SmtpConfig = Pick<Config, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_FROM'>;

/** Bounds every SMTP phase, so a dead server fails the attempt instead of hanging the job. */
export const SMTP_TIMEOUT_MS = 5_000;

/**
 * Mailer over SMTP (nodemailer). Port 465 uses implicit TLS; other ports upgrade with STARTTLS
 * when the server offers it (Mailpit in dev/tests does not). Auth only when SMTP_USER is set.
 */
export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(msg) {
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
    },
  };
}

/** pg-boss queue of letters; a job's data is `{ logId }` (`email_log.id`). */
export const EMAIL_QUEUE = 'email';

/** `settings` key holding the ISO time of the last successful SMTP send (`/api/health`). */
export const SMTP_LAST_OK_KEY = 'smtp_last_ok_at';

/** What `enqueueEmail` and the email job need from pg-boss (a real `PgBoss` fits). */
export interface EmailQueue {
  send(name: string, data: object, options: PgBoss.SendOptions): Promise<string | null>;
}

export type EmailKind = 'verify' | 'reset' | 'reminder' | 'alert';

export interface OutgoingEmail extends MailMessage {
  /** Null for mail not tied to an account. */
  userId: string | null;
  kind: EmailKind;
}

export interface EnqueueContext {
  mailer: Mailer;
  now: () => number;
  log?: MailLog;
}

/** Logger surface the delivery code uses (pino / Fastify's logger fits). */
export type MailLog = Pick<FastifyBaseLogger, 'warn' | 'error'>;

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 2000);

/** Pauses between tries of a journal write after a letter went out (3 tries in all). */
export const JOURNAL_RETRY_DELAYS_MS = [100, 400] as const;

/** Runs `fn`, retrying after each delay in `delays` while it throws. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  delays: readonly number[] = JOURNAL_RETRY_DELAYS_MS,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const delay = delays[i];
      if (delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** One delivery attempt of an `email_log` row (see `attemptDelivery`). */
export type Attempt =
  | { outcome: 'skipped' }
  | { outcome: 'delivered'; attempts: number }
  | { outcome: 'error'; attempts: number; error: string; permanent: boolean };

/**
 * Claims the row and sends the stored letter. The claim is exclusive: one `UPDATE` sets
 * `claimed_at` and `attempts + 1` only on a `queued` row nobody holds, so of two jobs for one
 * row only one sends. The holder must write an outcome that releases the claim (`markSent`,
 * `releaseForRetry`, `markFailed`); a claim that is never released is closed by the sweep as
 * "outcome unknown" and never resent. Only the send itself counts as a failed attempt.
 */
export async function attemptDelivery(
  db: Executor,
  mailer: Mailer,
  logId: number,
  at: Date,
): Promise<Attempt> {
  const [row] = await db
    .update(emailLog)
    .set({ attempts: sql`${emailLog.attempts} + 1`, claimedAt: at })
    .where(and(eq(emailLog.id, logId), eq(emailLog.status, 'queued'), isNull(emailLog.claimedAt)))
    .returning();
  if (!row) return { outcome: 'skipped' };
  if (row.recipient === null || row.subject === null || row.textBody === null) {
    return {
      outcome: 'error',
      attempts: row.attempts,
      error: 'letter is missing',
      permanent: true,
    };
  }
  try {
    await mailer.send({
      to: row.recipient,
      subject: row.subject,
      text: row.textBody,
      html: row.htmlBody ?? undefined,
    });
  } catch (err) {
    return { outcome: 'error', attempts: row.attempts, error: errorText(err), permanent: false };
  }
  return { outcome: 'delivered', attempts: row.attempts };
}

const SENT_FIELDS = (at: Date) =>
  ({
    status: 'sent',
    sentAt: at,
    lastError: null,
    claimedAt: null,
    subject: null,
    textBody: null,
    htmlBody: null,
  }) as const;

/**
 * Journals a delivered letter: in one transaction the row becomes `sent` (body dropped, claim
 * released) and `settings.smtp_last_ok_at` is updated; retried with short pauses. If that keeps
 * failing, a bare `sent` mark without the settings write is tried. Returns false only when no
 * write succeeded: the row stays claimed, and the sweep later closes it without resending.
 */
export async function markSent(
  db: Executor,
  logId: number,
  at: Date,
  log?: MailLog,
): Promise<boolean> {
  try {
    await withRetries(() =>
      db.transaction(async (tx) => {
        await tx.update(emailLog).set(SENT_FIELDS(at)).where(eq(emailLog.id, logId));
        await setSetting(tx, SMTP_LAST_OK_KEY, at.toISOString());
      }),
    );
    return true;
  } catch (err) {
    log?.error({ err, emailLogId: logId }, 'email sent; journal transaction failed');
  }
  try {
    await db.update(emailLog).set(SENT_FIELDS(at)).where(eq(emailLog.id, logId));
    return true;
  } catch (err) {
    log?.error({ err, emailLogId: logId }, 'email sent but its status could not be recorded');
    return false;
  }
}

/**
 * Failed attempt that will be retried: records the error and when the retry is due, and
 * releases the claim (so the sweep can re-queue the row if the retry job never materialises).
 */
export async function releaseForRetry(
  db: Executor,
  logId: number,
  error: string,
  nextAttemptAt: Date,
): Promise<void> {
  await withRetries(() =>
    db
      .update(emailLog)
      .set({ lastError: error, nextAttemptAt, claimedAt: null })
      .where(eq(emailLog.id, logId)),
  );
}

/** Gives up on a letter: `failed`, body dropped, claim released. */
export async function markFailed(db: Executor, logId: number, error: string): Promise<void> {
  await withRetries(() =>
    db
      .update(emailLog)
      .set({
        status: 'failed',
        lastError: error,
        claimedAt: null,
        subject: null,
        textBody: null,
        htmlBody: null,
      })
      .where(eq(emailLog.id, logId)),
  );
}

/**
 * Records the letter in `email_log` (`queued`, with its address and body) and delivers it.
 * With a queue: sends one `email` job (`{ logId }`, built-in retry off); the job handler
 * (`jobs/email.ts`) sends and runs the retry ladder, and the sweep re-queues the row if this
 * `send` fails. Without one (tests, R-M2-1): one inline attempt; failure leaves the row `queued`
 * with `attempts` and `last_error`. Delivery problems are only logged — the caller's request
 * still succeeds. Returns the row id.
 */
export async function enqueueEmail(
  queue: EmailQueue | null,
  db: Executor,
  email: OutgoingEmail,
  ctx: EnqueueContext,
): Promise<number> {
  const createdAt = new Date(ctx.now());
  const [row] = await db
    .insert(emailLog)
    .values({
      userId: email.userId,
      kind: email.kind,
      createdAt,
      nextAttemptAt: createdAt,
      recipient: email.to,
      subject: email.subject,
      textBody: email.text,
      htmlBody: email.html ?? null,
    })
    .returning({ id: emailLog.id });
  const id = row!.id;
  const logCtx = { emailLogId: id, kind: email.kind };

  if (queue) {
    try {
      await queue.send(EMAIL_QUEUE, { logId: id }, { retryLimit: 0 });
    } catch (err) {
      ctx.log?.error({ err, ...logCtx }, 'email job could not be queued; the sweep will retry');
    }
    return id;
  }

  const attempt = await attemptDelivery(db, ctx.mailer, id, new Date(ctx.now()));
  if (attempt.outcome === 'error') {
    ctx.log?.warn({ err: attempt.error, ...logCtx }, 'email delivery failed');
    try {
      await releaseForRetry(db, id, attempt.error, new Date(ctx.now()));
    } catch (err) {
      ctx.log?.error({ err, ...logCtx }, 'email delivery failure could not be recorded');
    }
  } else if (attempt.outcome === 'delivered') {
    await markSent(db, id, new Date(ctx.now()), ctx.log);
  }
  return id;
}
