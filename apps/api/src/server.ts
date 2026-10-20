import { MAX_HEARTS } from '@rootcamp/logic';
import pg from 'pg';
import { buildApp } from './app.js';
import { parsePort } from './config.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

let port: number;
try {
  port = parsePort(process.env.PORT);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const host = process.env.HOST ?? '0.0.0.0';

const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
// An idle client losing its connection must not crash the process.
pool.on('error', (err) => console.error('pg pool error:', err.message));

const app = buildApp({
  db: {
    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  },
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  let exitCode = 0;
  try {
    await app.close();
  } catch (err) {
    console.error('error closing http server:', (err as Error).message);
    exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch (err) {
      console.error('error closing pg pool:', (err as Error).message);
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port, host });
// Uses @rootcamp/logic at runtime so the built image exercises workspace-package resolution.
console.log(`api listening on http://${host}:${port} (logic: MAX_HEARTS=${MAX_HEARTS})`);
