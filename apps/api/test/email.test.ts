// Email queue (spec §9): pg-boss `email` jobs carry only `email_log.id`; the handler claims the
// row, sends, journals the outcome and schedules its own retries on the 1/5/15/60/240-minute
// ladder (built-in pg-boss retry is off). A sweep re-queues rows that lost their job and closes
// rows whose outcome is unknown. Jobs are run by calling the handler directly, so timing never
// matters here; one test checks that a real worker picks a job up.
import { emailLog, settings } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { startBoss } from '../src/jobs/boss.js';
import {
  CLAIM_LEASE_MS,
  EMAIL_QUEUE,
  handleEmailJob,
  RETRY_DELAYS_MIN,
  startEmailWorker,
  sweepEmailLog,
  SWEEP_GRACE_MS,
  type EmailJobData,
  type EmailWorkerDeps,
} from '../src/jobs/email.js';
import { createSmtpMailer, enqueueEmail, type OutgoingEmail } from '../src/services/mailer.js';
import type { Mailer } from '../src/types.js';
import { harnessAppDeps, TEST_PUBLIC_ORIGIN, useHarness } from './harness.js';

const h = useHarness();

const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };
const MIN = 60_000;

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

/** A queue whose `send` always throws (pg-boss or its database unavailable). */
const brokenQueue = {
  async send(): Promise<string | null> {
    throw new Error('queue down');
  },
};

/** Logger stub for code paths that log errors. */
const silentLog = { error: () => {}, warn: () => {} };

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
      claimedAt: null,
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
      claimedAt: null,
    });
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent[1]).toEqual({
      name: EMAIL_QUEUE,
      data: { logId: id },
      options: expect.objectContaining({ retryLimit: 0, startAfter: 60 }),
    });

    h().clock.advance(MIN);
    expect(await handleEmailJob(deps, job(id))).toBe('sent');
    const row = await logRow(id);
    expect(row).toMatchObject({ status: 'sent', attempts: 2, lastError: null, claimedAt: null });
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
    for (let i = 0; i < 6; i++) {
      outcomes.push(await handleEmailJob(deps, job(id)));
      h().clock.advance((RETRY_DELAYS_MIN[i] ?? 0) * MIN);
    }

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
      subject: null,
      textBody: null,
      htmlBody: null,
      claimedAt: null,
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

  it('two jobs for one row at the same time: the letter goes out once', async () => {
    const queue = recordingQueue();
    const mailer = flakyMailer(0);
    const slow: Mailer = {
      async send(msg) {
        await new Promise((r) => setTimeout(r, 300));
        await mailer.send(msg);
      },
    };
    const deps = workerDeps(slow, queue);
    const id = await enqueueEmail(queue, h().db, letter, { mailer, now: h().clock.now });

    const outcomes = await Promise.all([
      handleEmailJob(deps, job(id)),
      handleEmailJob(deps, job(id)),
    ]);
    expect(outcomes.sort()).toEqual(['sent', 'skipped']);
    expect(mailer.calls).toBe(1);
    expect(await logRow(id)).toMatchObject({ status: 'sent', attempts: 1, claimedAt: null });
  });

  it('sent, but the journal transaction keeps failing: falls back to a bare `sent` mark', async () => {
    const queue = recordingQueue();
    const mailer = flakyMailer(0);
    const deps = { ...workerDeps(mailer, queue), log: silentLog as never };
    const id = await enqueueEmail(queue, h().db, letter, { mailer, now: h().clock.now });

    const { sql } = h();
    await sql`alter table settings add constraint test_no_smtp_ok check (key <> 'smtp_last_ok_at') not valid`;
    try {
      expect(await handleEmailJob(deps, job(id))).toBe('sent');
    } finally {
      await sql`alter table settings drop constraint test_no_smtp_ok`;
    }
    expect(mailer.calls).toBe(1);
    expect(queue.sent).toHaveLength(1); // no retry
    expect(await logRow(id)).toMatchObject({
      status: 'sent',
      attempts: 1,
      lastError: null,
      claimedAt: null,
      subject: null,
      textBody: null,
      htmlBody: null,
    });
  });
});

describe('inline delivery (no queue)', () => {
  it('sent, but no write to `sent` works: the request still succeeds, no error recorded', async () => {
    const mailer = flakyMailer(0);
    let id = 0;
    await withSentForbidden(async () => {
      id = await enqueueEmail(null, h().db, letter, { mailer, now: h().clock.now });
    });
    expect(mailer.calls).toBe(1);
    const row = await logRow(id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, lastError: null });
    // Still claimed: the sweep closes it as "outcome unknown" instead of resending.
    expect(row.claimedAt).not.toBeNull();
  });

  it('a successful inline send also records smtp_last_ok_at', async () => {
    const mailer = flakyMailer(0);
    await enqueueEmail(null, h().db, letter, { mailer, now: h().clock.now });
    const res = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({
      db: true,
      sandboxd: false,
      smtpLastOkAt: new Date(h().clock.now()).toISOString(),
    });
  });
});

describe('GET /api/health smtpLastOkAt', () => {
  it('is null until a letter goes out, then the time of the last successful send', async () => {
    const before = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(before.json()).toEqual({ db: true, sandboxd: false, smtpLastOkAt: null });

    const queue = recordingQueue();
    const deps = workerDeps(flakyMailer(0), queue);
    const id = await enqueueEmail(queue, h().db, letter, deps);
    h().clock.advance(5_000);
    await handleEmailJob(deps, job(id));

    const after = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({
      db: true,
      sandboxd: false,
      smtpLastOkAt: new Date(h().clock.now()).toISOString(),
    });
  });
});

describe('with pg-boss', () => {
  let boss: PgBoss;
  beforeAll(async () => {
    boss = await startBoss({ DATABASE_URL: h().databaseUrl }, silentLog);
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

  it('retry scheduling fails: the row stays reconcilable and the sweep recovers it', async () => {
    const mailer = flakyMailer(1);
    const id = await enqueueEmail(boss, h().db, letter, { mailer, now: h().clock.now });
    await h().sql`delete from pgboss.job`; // the original job has been consumed

    const failing = { ...workerDeps(mailer, brokenQueue), log: silentLog as never };
    expect(await handleEmailJob(failing, job(id))).toBe('stalled');
    expect(await logRow(id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: 'smtp down',
      claimedAt: null,
    });

    const deps = workerDeps(mailer, boss);
    // Not before the retry was due plus the grace period.
    h().clock.advance(MIN + SWEEP_GRACE_MS - 1_000);
    expect(await sweepEmailLog(deps)).toEqual({ requeued: [], abandoned: [] });
    h().clock.advance(2_000);
    expect(await sweepEmailLog(deps)).toEqual({ requeued: [id], abandoned: [] });

    const [requeued] = await boss.fetch<EmailJobData>(EMAIL_QUEUE);
    expect(requeued?.data).toEqual({ logId: id });
    expect(await handleEmailJob(deps, requeued!)).toBe('sent');
    expect(await logRow(id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(mailer.calls).toBe(2);
  });

  it('a letter whose job could not be queued is picked up by the sweep', async () => {
    const mailer = flakyMailer(0);
    const id = await enqueueEmail(brokenQueue, h().db, letter, { mailer, now: h().clock.now });
    expect(await logRow(id)).toMatchObject({ status: 'queued', attempts: 0 });

    h().clock.advance(SWEEP_GRACE_MS + 1_000);
    expect(await sweepEmailLog(workerDeps(mailer, boss))).toEqual({
      requeued: [id],
      abandoned: [],
    });
    const [found] = await boss.fetch<EmailJobData>(EMAIL_QUEUE);
    expect(found?.data).toEqual({ logId: id });
  });

  it('the sweep leaves rows whose job is still pending or active alone', async () => {
    const mailer = flakyMailer(0);
    const deps = workerDeps(mailer, boss);
    const id = await enqueueEmail(boss, h().db, letter, { mailer, now: h().clock.now });
    h().clock.advance(SWEEP_GRACE_MS + 1_000);

    expect(await sweepEmailLog(deps)).toEqual({ requeued: [], abandoned: [] }); // created
    const [active] = await boss.fetch<EmailJobData>(EMAIL_QUEUE);
    expect(active?.data).toEqual({ logId: id });
    expect(await sweepEmailLog(deps)).toEqual({ requeued: [], abandoned: [] }); // active
    const [row] = await h().sql<{ n: number }[]>`select count(*)::int as n from pgboss.job`;
    expect(row!.n).toBe(1);
  });

  it('sent but unrecorded (claim never released): the sweep marks it failed, never resends', async () => {
    const mailer = flakyMailer(0);
    const deps = { ...workerDeps(mailer, boss), log: silentLog as never };
    const id = await enqueueEmail(boss, h().db, letter, { mailer, now: h().clock.now });
    await h().sql`delete from pgboss.job`;

    await withSentForbidden(async () => {
      expect(await handleEmailJob(deps, job(id))).toBe('stalled');
    });
    expect(await logRow(id)).toMatchObject({ status: 'queued', attempts: 1, lastError: null });

    // A stray job while the claim is held does nothing.
    expect(await handleEmailJob(deps, job(id))).toBe('skipped');

    h().clock.advance(CLAIM_LEASE_MS - 1_000);
    expect(await sweepEmailLog(deps)).toEqual({ requeued: [], abandoned: [] });
    h().clock.advance(SWEEP_GRACE_MS);
    expect(await sweepEmailLog(deps)).toEqual({ requeued: [], abandoned: [id] });
    expect(await logRow(id)).toMatchObject({
      status: 'failed',
      lastError: expect.stringMatching(/outcome unknown/),
      claimedAt: null,
      subject: null,
      textBody: null,
      htmlBody: null,
    });
    expect(mailer.calls).toBe(1);
    expect(await boss.fetch(EMAIL_QUEUE, { ignoreStartAfter: true })).toEqual([]);
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
