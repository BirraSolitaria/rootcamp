import { fileURLToPath } from 'node:url';
import { createDb, runMigrations } from '@rootcamp/db';
import { MAX_HEARTS } from '@rootcamp/logic';
import type { FastifyInstance } from 'fastify';
import type PgBoss from 'pg-boss';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { startBoss } from './jobs/boss.js';
import { startEmailWorker } from './jobs/email.js';
import { createSmtpMailer } from './services/mailer.js';

/** Shipped next to dist/ (package.json `files`), so this resolves both from src/ and dist/. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/** How long shutdown waits for an in-flight email job before stopping pg-boss anyway. */
const BOSS_STOP_TIMEOUT_MS = 10_000;

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// Pool ≥ 2: runMigrations holds the advisory lock on one connection while migrating on another.
const handle = createDb(config.DATABASE_URL, { max: 10 });

const mailer = createSmtpMailer(config);

let app: FastifyInstance | undefined;
let boss: PgBoss | undefined;
let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason}, shutting down`);
  try {
    await app?.close();
  } catch (err) {
    console.error('error closing http server:', (err as Error).message);
    exitCode = 1;
  }
  try {
    // Lets the running email job finish; queued jobs stay in `pgboss` for the next start.
    await boss?.stop({ graceful: true, wait: true, timeout: BOSS_STOP_TIMEOUT_MS });
  } catch (err) {
    console.error('error stopping pg-boss:', (err as Error).message);
    exitCode = 1;
  }
  try {
    await handle.close();
  } catch (err) {
    console.error('error closing database pool:', (err as Error).message);
    exitCode = 1;
  }
  process.exit(exitCode);
}
process.once('SIGTERM', () => void shutdown('SIGTERM received'));
process.once('SIGINT', () => void shutdown('SIGINT received'));

try {
  // Serialised across replicas by an advisory lock inside runMigrations.
  await runMigrations(handle.db, MIGRATIONS_DIR);
  boss = await startBoss(config);
  app = await buildApp({
    config,
    db: handle.db,
    now: Date.now,
    mailer,
    boss,
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
  });
  const log = app.log;
  await startEmailWorker(boss, { db: handle.db, mailer, queue: boss, now: Date.now, log });
  await app.listen({ port: config.PORT, host: config.HOST });
  // Uses @rootcamp/logic at runtime so the built image exercises workspace-package resolution.
  app.log.info(`api listening on ${config.HOST}:${config.PORT} (logic: MAX_HEARTS=${MAX_HEARTS})`);
} catch (err) {
  console.error('startup failed:', err);
  await shutdown('startup failed', 1);
}
