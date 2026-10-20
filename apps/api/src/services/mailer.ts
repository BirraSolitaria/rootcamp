import { emailLog } from '@rootcamp/db';
import { and, eq, sql } from 'drizzle-orm';
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
  log?: FastifyBaseLogger;
}

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 2000);

/** One delivery attempt of an `email_log` row (see `attemptDelivery`). */
export type Attempt =
  | { outcome: 'skipped' }
  | { outcome: 'delivered'; attempts: number }
  | { outcome: 'error'; attempts: number; error: string; permanent: boolean };

/**
 * Claims the row (`attempts + 1`, only while `queued`) and sends the stored letter. Only the
 * send itself counts as a failed attempt; marking the row `sent` is the caller's next step
 * (`markSent`), so a failure there can never schedule a duplicate letter.
 */
export async function attemptDelivery(
  db: Executor,
  mailer: Mailer,
  logId: number,
): Promise<Attempt> {
  const [row] = await db
    .update(emailLog)
    .set({ attempts: sql`${emailLog.attempts} + 1` })
    .where(and(eq(emailLog.id, logId), eq(emailLog.status, 'queued')))
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

/** Delivered: `sent` + `sent_at`, body dropped, `settings.smtp_last_ok_at` updated. */
export async function markSent(db: Executor, logId: number, at: Date): Promise<void> {
  await db
    .update(emailLog)
    .set({
      status: 'sent',
      sentAt: at,
      lastError: null,
      subject: null,
      textBody: null,
      htmlBody: null,
    })
    .where(eq(emailLog.id, logId));
  await setSetting(db, SMTP_LAST_OK_KEY, at.toISOString());
}

/**
 * Records the letter in `email_log` (`queued`, with its address and body) and delivers it.
 * With a queue: sends one `email` job (`{ logId }`, built-in retry off); the job handler
 * (`jobs/email.ts`) sends and runs the retry ladder. Without one (tests, R-M2-1): one inline
 * attempt; failure leaves the row `queued` with `attempts` and `last_error`.
 * Delivery problems are only logged — the caller's request still succeeds. Returns the row id.
 */
export async function enqueueEmail(
  queue: EmailQueue | null,
  db: Executor,
  email: OutgoingEmail,
  ctx: EnqueueContext,
): Promise<number> {
  const [row] = await db
    .insert(emailLog)
    .values({
      userId: email.userId,
      kind: email.kind,
      createdAt: new Date(ctx.now()),
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
      ctx.log?.error({ err, ...logCtx }, 'email job could not be queued');
    }
    return id;
  }

  const attempt = await attemptDelivery(db, ctx.mailer, id);
  if (attempt.outcome === 'error') {
    ctx.log?.warn({ err: attempt.error, ...logCtx }, 'email delivery failed');
    await db.update(emailLog).set({ lastError: attempt.error }).where(eq(emailLog.id, id));
  } else if (attempt.outcome === 'delivered') {
    try {
      await markSent(db, id, new Date(ctx.now()));
    } catch (err) {
      // The letter went out; it stays `queued` rather than being reported as failed.
      ctx.log?.error({ err, ...logCtx }, 'email sent but its status was not recorded');
    }
  }
  return id;
}
