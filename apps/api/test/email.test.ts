// Email queue (spec §9): pg-boss `email` jobs carry only `email_log.id`; the handler sends, journals
// the outcome and schedules its own retries on the 1/5/15/60/240-minute ladder (built-in pg-boss
// retry is off). Jobs are run by calling the handler directly, so timing never matters here; one
// test checks that a real worker picks a job up.
import { emailLog, settings } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { startBoss } from '../src/jobs/boss.js';
import {
  EMAIL_QUEUE,
  handleEmailJob,
  RETRY_DELAYS_MIN,
  startEmailWorker,
  type EmailJobData,
  type EmailWorkerDeps,
} from '../src/jobs/email.js';
import { createSmtpMailer, enqueueEmail, type OutgoingEmail } from '../src/services/mailer.js';
import type { Mailer } from '../src/types.js';
import { harnessAppDeps, TEST_PUBLIC_ORIGIN, useHarness } from './harness.js';

const h = useHarness();

const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };

const letter: OutgoingEmail = {
  userId: null,
  kind: 'alert',
  to: 'ops@mail.ru',
  subject: 'alert',
  text: 'something happened',
  html: '<p>something happened</p>',
};

interface Sent {
  name: string;
  data: EmailJobData;
  options: PgBoss.SendOptions | undefined;
}

/** Stands in for pg-boss: records `send` calls instead of queueing. */
function recordingQueue() {
  const sent: Sent[] = [];
  return {
    sent,
    async send(name: string, data: object, options?: PgBoss.SendOptions) {
      sent.push({ name, data: data as EmailJobData, options });
      return `job-${sent.length}`;
    },
  };
}

/** Real SMTP mailer into Mailpit that throws on its first `failures` calls. */
function flakyMailer(failures: number): Mailer & { calls: number } {
  const smtp = createSmtpMailer(harnessAppDeps(h().deps).config);
  const m = {
    calls: 0,
    async send(msg: Parameters<Mailer['send']>[0]) {
      m.calls += 1;
      if (m.calls <= failures) throw new Error('smtp down');
      await smtp.send(msg);
    },
  };
  return m;
}

function workerDeps(mailer: Mailer, queue: EmailWorkerDeps['queue']): EmailWorkerDeps {
  return { db: h().db, mailer, queue, now: h().clock.now };
}

async function logRow(id: number) {
  const [row] = await h().db.select().from(emailLog).where(eq(emailLog.id, id));
  return row!;
}

const job = (logId: number) => ({ data: { logId } });

describe('enqueueEmail with a queue', () => {
  it('stores the letter as queued and sends one `email` job with built-in retry off', async () => {
    const queue = recordingQueue();
    const mailer = flakyMailer(0);
    const id = await enqueueEmail(queue, h().db, letter, { mailer, now: h().clock.now });

    expect(mailer.calls).toBe(0);
    expect(queue.sent).toEqual([
      {
        name: EMAIL_QUEUE,
        data: { logId: id },
        options: expect.objectContaining({ retryLimit: 0 }),
      },
    ]);
    expect(await logRow(id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      recipient: 'ops@mail.ru',
      subject: 'alert',
      textBody: 'something happened',
      htmlBody: '<p>something happened</p>',
    });
  });
});

describe('email job handler', () => {
  it('fails once, retries after 1 min, then sends: status sent, attempts 2', async () => {
    const queue = recordingQueue();
    const mailer = flakyMailer(1);
    const deps = workerDeps(mailer, queue);
    const id = await enqueueEmail(queue, h().db, letter, { mailer, now: h().clock.now });

    expect(await handleEmailJob(deps, job(id))).toBe('retry');
    expect(await logRow(id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: 'smtp down',
    });
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent[1]).toEqual({
      name: EMAIL_QUEUE,
      data: { logId: id },
      options: expect.objectContaining({ retryLimit: 0, startAfter: 60 }),
    });

    h().clock.advance(60_000);
    expect(await handleEmailJob(deps, job(id))).toBe('sent');
    const row = await logRow(id);
    expect(row).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
    expect(row.sentAt?.getTime()).toBe(h().clock.now());
    // The body (it may hold a one-time link) is dropped once delivered; the address stays.
    expect(row).toMatchObject({
      recipient: 'ops@mail.ru',
      subject: null,
      textBody: null,
      htmlBody: null,
    });
    expect(queue.sent).toHaveLength(2);

    const [msg] = await h().mail.waitForMessages('ops@mail.ru');
    expect(msg!.subject).toBe('alert');
    const [ok] = await h().db.select().from(settings).where(eq(settings.key, 'smtp_last_ok_at'));
    expect(ok?.value).toBe(new Date(h().clock.now()).toISOString());
  });

  it('always failing: retries on the 1/5/15/60/240 min ladder, failed after 6 attempts', async () => {
    const queue = recordingQueue();
    const mailer = flakyMailer(Infinity);
    const deps = workerDeps(mailer, queue);
    const id = await enqueueEmail(queue, h().db, letter, { mailer, now: h().clock.now });

    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push(await handleEmailJob(deps, job(id)));

    expect(outcomes).toEqual(['retry', 'retry', 'retry', 'retry', 'retry', 'failed']);
    expect(RETRY_DELAYS_MIN).toEqual([1, 5, 15, 60, 240]);
    expect(queue.sent.slice(1).map((s) => s.options?.startAfter)).toEqual([
      60, 300, 900, 3600, 14400,
    ]);
    expect(mailer.calls).toBe(6);
    expect(await logRow(id)).toMatchObject({
      status: 'failed',
      attempts: 6,
      lastError: 'smtp down',
      sentAt: null,
      recipient: 'ops@mail.ru',
      textBody: null,
    });

    // A stray job for a finished row does nothing.
    expect(await handleEmailJob(deps, job(id))).toBe('skipped');
    expect(mailer.calls).toBe(6);
  });

  it('a job for an already sent row does not send again', async () => {
    const queue = recordingQueue();
    const mailer = flakyMailer(0);
    const deps = workerDeps(mailer, queue);
    const id = await enqueueEmail(queue, h().db, letter, { mailer, now: h().clock.now });

    expect(await handleEmailJob(deps, job(id))).toBe('sent');
    expect(await handleEmailJob(deps, job(id))).toBe('skipped');
    expect(mailer.calls).toBe(1);
    expect(await logRow(id)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('send succeeded but the status update failed: no retry, no error recorded (no duplicate)', async () => {
    const queue = recordingQueue();
    const mailer = flakyMailer(0);
    const deps = workerDeps(mailer, queue);
    const id = await enqueueEmail(queue, h().db, letter, { mailer, now: h().clock.now });

    await withSentForbidden(async () => {
      await expect(handleEmailJob(deps, job(id))).rejects.toThrow();
    });
    expect(mailer.calls).toBe(1);
    expect(queue.sent).toHaveLength(1); // only the original job
    expect(await logRow(id)).toMatchObject({ status: 'queued', attempts: 1, lastError: null });
  });
});

describe('inline delivery (no queue)', () => {
  it('send succeeded but the status update failed: the request still succeeds, no error recorded', async () => {
    const mailer = flakyMailer(0);
    let id = 0;
    await withSentForbidden(async () => {
      id = await enqueueEmail(null, h().db, letter, { mailer, now: h().clock.now });
    });
    expect(mailer.calls).toBe(1);
    expect(await logRow(id)).toMatchObject({ status: 'queued', attempts: 1, lastError: null });
  });

  it('a successful inline send also records smtp_last_ok_at', async () => {
    const mailer = flakyMailer(0);
    await enqueueEmail(null, h().db, letter, { mailer, now: h().clock.now });
    const res = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ db: true, smtpLastOkAt: new Date(h().clock.now()).toISOString() });
  });
});

describe('GET /api/health smtpLastOkAt', () => {
  it('is null until a letter goes out, then the time of the last successful send', async () => {
    const before = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(before.json()).toEqual({ db: true, smtpLastOkAt: null });

    const queue = recordingQueue();
    const deps = workerDeps(flakyMailer(0), queue);
    const id = await enqueueEmail(queue, h().db, letter, deps);
    h().clock.advance(5_000);
    await handleEmailJob(deps, job(id));

    const after = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({
      db: true,
      smtpLastOkAt: new Date(h().clock.now()).toISOString(),
    });
  });
});

describe('with pg-boss', () => {
  let boss: PgBoss;
  beforeAll(async () => {
    boss = await startBoss({ DATABASE_URL: h().databaseUrl });
  }, 60_000);
  beforeEach(async () => {
    await h().sql`delete from pgboss.job`;
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
  });

  it('SMTP down during registration: 201, letter stays queued, delivered after recovery', async () => {
    const mailer = flakyMailer(1);
    const app = await buildApp({ ...harnessAppDeps(h().deps), mailer, boss });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: csrf,
        payload: {
          email: 'ann@mail.ru',
          nick: 'ann',
          password: 'correct horse battery',
          tz: 'Europe/Moscow',
        },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
    const [queued] = await h().db.select().from(emailLog);
    expect(queued).toMatchObject({ kind: 'verify', status: 'queued', attempts: 0 });
    expect(mailer.calls).toBe(0);

    const deps = workerDeps(mailer, boss);
    const [first] = await boss.fetch<EmailJobData>(EMAIL_QUEUE);
    expect(first?.data).toEqual({ logId: queued!.id });
    expect(await handleEmailJob(deps, first!)).toBe('retry');
    await boss.complete(EMAIL_QUEUE, first!.id);

    // The retry waits a minute: not fetchable yet, picked up once its time has come.
    expect(await boss.fetch(EMAIL_QUEUE)).toEqual([]);
    const [retry] = await boss.fetch<EmailJobData>(EMAIL_QUEUE, { ignoreStartAfter: true });
    expect(retry?.data).toEqual({ logId: queued!.id });
    expect(await handleEmailJob(deps, retry!)).toBe('sent');

    expect(await logRow(queued!.id)).toMatchObject({ status: 'sent', attempts: 2 });
    const [msg] = await h().mail.waitForMessages('ann@mail.ru');
    expect(msg!.text).toContain('/verify?token=');
  });

  it('a running worker picks the job up and delivers it', async () => {
    const mailer = flakyMailer(0);
    const workerId = await startEmailWorker(boss, workerDeps(mailer, boss), {
      pollingIntervalSeconds: 0.5,
    });
    try {
      const id = await enqueueEmail(boss, h().db, letter, { mailer, now: h().clock.now });
      await h().mail.waitForMessages('ops@mail.ru', 1, 10_000);
      await expect.poll(async () => (await logRow(id)).status, { timeout: 5_000 }).toBe('sent');
    } finally {
      await boss.offWork({ id: workerId });
    }
  }, 20_000);
});

/** Runs `fn` while any update of `email_log` to `sent` is rejected by the database. */
async function withSentForbidden(fn: () => Promise<void>): Promise<void> {
  const { sql } = h();
  await sql`alter table email_log add constraint test_no_sent check (status <> 'sent') not valid`;
  try {
    await fn();
  } finally {
    await sql`alter table email_log drop constraint test_no_sent`;
  }
}
