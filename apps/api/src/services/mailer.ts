import { emailLog } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import type { MailMessage, Mailer, PgBoss } from '../types.js';
import type { Executor } from './executor.js';

export type { MailMessage, Mailer } from '../types.js';

type SmtpConfig = Pick<Config, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_FROM'>;

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

/**
 * Records the letter in `email_log` (`queued`) and delivers it. Until the pg-boss queue lands
 * (Task 6, R-M2-1) delivery is inline: success marks the row `sent`; failure leaves it `queued`
 * with `attempts` and `last_error` and is only logged — the caller's request still succeeds.
 * Returns the `email_log` id.
 */
export async function enqueueEmail(
  _boss: PgBoss | null,
  db: Executor,
  email: OutgoingEmail,
  ctx: EnqueueContext,
): Promise<number> {
  const [row] = await db
    .insert(emailLog)
    .values({ userId: email.userId, kind: email.kind, createdAt: new Date(ctx.now()) })
    .returning({ id: emailLog.id });
  const id = row!.id;

  try {
    await ctx.mailer.send({
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    await db
      .update(emailLog)
      .set({ status: 'sent', attempts: 1, sentAt: new Date(ctx.now()), lastError: null })
      .where(eq(emailLog.id, id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log?.warn({ err, emailLogId: id, kind: email.kind }, 'email delivery failed');
    await db
      .update(emailLog)
      .set({ attempts: 1, lastError: message.slice(0, 2000) })
      .where(eq(emailLog.id, id));
  }
  return id;
}
