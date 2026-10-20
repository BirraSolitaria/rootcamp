// Integration test harness (spec §10.2): real PostgreSQL 16 with migrations and Mailpit as SMTP,
// both via Testcontainers, one set per test file. Between tests every public table is TRUNCATEd
// (CASCADE), default settings are re-seeded, the mailbox is emptied and the clock is reset.
//
//   const h = useHarness();            // registers beforeAll / beforeEach / afterAll
//   it('...', async () => { const { app, db, mail, clock } = h(); ... });
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDb,
  DEFAULT_SETTINGS,
  runMigrations,
  settings,
  type Db,
  type DbHandle,
} from '@rootcamp/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach } from 'vitest';

/** Same images as infra/versions.env. */
export const POSTGRES_IMAGE = 'postgres:16';
export const MAILPIT_IMAGE = 'axllent/mailpit:v1.27';

/** Generated drizzle migrations (apps/api/drizzle); `runMigrations` reads `meta/_journal.json` here. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Clock start for every test: Tue 2026-10-20 09:00:00Z (12:00 MSK). */
export const DEFAULT_START = Date.UTC(2026, 9, 20, 9, 0, 0);

type Sql = DbHandle['sql'];

const START_TIMEOUT_MS = 180_000;

export interface MailpitMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  created: string;
}

export interface Clock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

/** Everything an app factory may need; Task 3 maps this onto `AppDeps` for `buildApp`. */
export interface HarnessDeps {
  db: Db;
  sql: Sql;
  /** Pass as `deps.now`. */
  now: () => number;
  databaseUrl: string;
  smtp: { host: string; port: number };
  mailpitUrl: string;
  /** Rate-limit overrides (R-M2-3), forwarded verbatim from `HarnessOpts.limits`. */
  limits?: Record<string, unknown>;
}

export type AppFactory = (deps: HarnessDeps) => FastifyInstance | Promise<FastifyInstance>;

export interface HarnessOpts {
  /** Builds the app under test. Default: a bare Fastify instance (replaced by `buildApp` in Task 3). */
  appFactory?: AppFactory;
  /** Rate-limit overrides forwarded to the factory (R-M2-3). */
  limits?: Record<string, unknown>;
  /** Clock value at the start of every test. Default: `DEFAULT_START`. */
  startTime?: number;
}

export interface Harness {
  app: FastifyInstance;
  db: Db;
  sql: Sql;
  databaseUrl: string;
  mail: {
    /** Messages addressed to `to` (exact, case-insensitive), oldest first. */
    messages(to: string): Promise<MailpitMessage[]>;
    /** Polls until at least `count` messages for `to` arrived. */
    waitForMessages(to: string, count?: number, timeoutMs?: number): Promise<MailpitMessage[]>;
    /** Test helper: drops a message into Mailpit through its HTTP send API. */
    send(msg: { to: string; subject: string; text: string; from?: string }): Promise<void>;
    clear(): Promise<void>;
  };
  clock: Clock;
  /** TRUNCATE all public tables, re-seed default settings, empty the mailbox, reset the clock. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const defaultAppFactory: AppFactory = () => Fastify({ logger: false });

function createClock(start: number): Clock {
  let current = start;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

// `localhost` resolves to ::1 first on this host and hangs on Docker-published ports.
function hostOf(c: StartedTestContainer): string {
  const host = c.getHost();
  return host === 'localhost' ? '127.0.0.1' : host;
}

/** Connection URL of a started Postgres container, pinned to 127.0.0.1 when Docker reports localhost. */
export function postgresUrl(c: StartedPostgreSqlContainer): string {
  return `postgres://${c.getUsername()}:${c.getPassword()}@${hostOf(c)}:${c.getPort()}/${c.getDatabase()}`;
}

interface MailpitAddress {
  Name: string;
  Address: string;
}
interface MailpitSummary {
  ID: string;
  To: MailpitAddress[];
  Cc: MailpitAddress[] | null;
  Bcc: MailpitAddress[] | null;
}
interface MailpitFull {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Text: string;
  HTML: string;
  Date: string;
}

function createMail(baseUrl: string): Harness['mail'] {
  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`Mailpit ${init?.method ?? 'GET'} ${path}: ${res.status}`);
    // DELETE / send answer with a plain "ok"; only JSON responses are parsed.
    const isJson = res.headers.get('content-type')?.includes('application/json');
    return (isJson ? await res.json() : await res.text()) as T;
  }

  async function messages(to: string): Promise<MailpitMessage[]> {
    const want = to.toLowerCase();
    const query = encodeURIComponent(`to:"${to}"`);
    const { messages: found } = await api<{ messages: MailpitSummary[] }>(
      `/api/v1/search?query=${query}&limit=1000`,
    );
    const ids = found
      .filter((m) =>
        [...m.To, ...(m.Cc ?? []), ...(m.Bcc ?? [])].some((a) => a.Address.toLowerCase() === want),
      )
      .map((m) => m.ID)
      .reverse(); // search returns newest first
    const full = await Promise.all(ids.map((id) => api<MailpitFull>(`/api/v1/message/${id}`)));
    return full.map((m) => ({
      id: m.ID,
      from: m.From.Address,
      to: m.To.map((a) => a.Address),
      subject: m.Subject,
      text: m.Text,
      html: m.HTML,
      created: m.Date,
    }));
  }

  return {
    messages,
    async waitForMessages(to, count = 1, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const msgs = await messages(to);
        if (msgs.length >= count) return msgs;
        if (Date.now() > deadline) {
          throw new Error(`expected ${count} message(s) to ${to}, got ${msgs.length}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async send({ to, subject, text, from = 'test@rootcamp.local' }) {
      await api('/api/v1/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          From: { Email: from },
          To: [{ Email: to }],
          Subject: subject,
          Text: text,
        }),
      });
    },
    async clear() {
      await api('/api/v1/messages', { method: 'DELETE' });
    },
  };
}

async function truncateAll(db: Db): Promise<void> {
  const rows = await db.$client<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'`;
  if (rows.length > 0) {
    const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await db.$client.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  }
  await db
    .insert(settings)
    .values(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value })));
}

export async function startHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const startTime = opts.startTime ?? DEFAULT_START;
  let pg: StartedPostgreSqlContainer | undefined;
  let mailpit: StartedTestContainer | undefined;
  let handle: DbHandle | undefined;
  try {
    [pg, mailpit] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new GenericContainer(MAILPIT_IMAGE)
        .withExposedPorts(1025, 8025)
        // A log wait: testcontainers probes HTTP via `localhost`, which hangs on this host (::1).
        .withWaitStrategy(Wait.forLogMessage(/\[http\] accessible via/))
        .start(),
    ]);

    const databaseUrl = postgresUrl(pg);
    handle = createDb(databaseUrl);
    await runMigrations(handle.db, MIGRATIONS_DIR);

    const mailpitUrl = `http://${hostOf(mailpit)}:${mailpit.getMappedPort(8025)}`;
    const mail = createMail(mailpitUrl);
    const clock = createClock(startTime);

    const factory = opts.appFactory ?? defaultAppFactory;
    const app = await factory({
      db: handle.db,
      sql: handle.sql,
      now: clock.now,
      databaseUrl,
      smtp: { host: hostOf(mailpit), port: mailpit.getMappedPort(1025) },
      mailpitUrl,
      limits: opts.limits,
    });
    await app.ready();

    const { db, sql, close: closeDb } = handle;
    const pgC = pg;
    const mailC = mailpit;
    return {
      app,
      db,
      sql,
      databaseUrl,
      mail,
      clock,
      async reset() {
        await truncateAll(db);
        await mail.clear();
        clock.set(startTime);
      },
      async close() {
        await app.close();
        await closeDb();
        await Promise.all([pgC.stop(), mailC.stop()]);
      },
    };
  } catch (err) {
    await handle?.close().catch(() => {});
    await Promise.all([pg?.stop(), mailpit?.stop()]).catch(() => {});
    throw err;
  }
}

/** Registers per-file lifecycle hooks and returns an accessor for the running harness. */
export function useHarness(opts: HarnessOpts = {}): () => Harness {
  let harness: Harness | undefined;
  beforeAll(async () => {
    harness = await startHarness(opts);
  }, START_TIMEOUT_MS);
  beforeEach(async () => {
    await harness?.reset();
  });
  afterAll(async () => {
    await harness?.close();
  }, 60_000);
  return () => {
    if (!harness) throw new Error('harness is not started (did beforeAll fail?)');
    return harness;
  };
}
