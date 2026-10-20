import pg from 'pg';
import { buildApp } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
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
  await app.close();
  await pool.end();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port, host });
console.log(`api listening on http://${host}:${port}`);
