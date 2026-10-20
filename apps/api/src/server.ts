import { fileURLToPath } from 'node:url';
import { createDb, runMigrations } from '@rootcamp/db';
import { MAX_HEARTS } from '@rootcamp/logic';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createSmtpMailer } from './services/mailer.js';

/** Shipped next to dist/ (package.json `files`), so this resolves both from src/ and dist/. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

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
  } finally {
    try {
      await handle.close();
    } catch (err) {
      console.error('error closing database pool:', (err as Error).message);
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}
process.once('SIGTERM', () => void shutdown('SIGTERM received'));
process.once('SIGINT', () => void shutdown('SIGINT received'));

try {
  // Serialised across replicas by an advisory lock inside runMigrations.
  await runMigrations(handle.db, MIGRATIONS_DIR);
  app = await buildApp({
    config,
    db: handle.db,
    now: Date.now,
    mailer,
    boss: null,
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
  });
  await app.listen({ port: config.PORT, host: config.HOST });
  // Uses @rootcamp/logic at runtime so the built image exercises workspace-package resolution.
  app.log.info(`api listening on ${config.HOST}:${config.PORT} (logic: MAX_HEARTS=${MAX_HEARTS})`);
} catch (err) {
  console.error('startup failed:', err);
  await shutdown('startup failed', 1);
}
