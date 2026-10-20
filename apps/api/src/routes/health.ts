import type { Db } from '@rootcamp/db';
import type { FastifyInstance } from 'fastify';
import { SMTP_LAST_OK_KEY } from '../services/mailer.js';
import { getSetting } from '../services/settings.js';

const PING_TIMEOUT_MS = 2000;

/** True when `select 1` succeeds within 2 s. */
export async function pingDb(db: Db): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
  });
  const ping = db.$client`select 1`.then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** ISO time of the last successful SMTP send (`settings.smtp_last_ok_at`), or null. */
async function smtpLastOkAt(db: Db): Promise<string | null> {
  try {
    const value = await getSetting<unknown>(db, SMTP_LAST_OK_KEY, null);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * `GET /api/health` → 200 `{db: true, smtpLastOkAt}` or 503 `{db: false, smtpLastOkAt: null}`;
 * used by the compose healthcheck. `smtpLastOkAt` (ISO or null) is informational: a stale value
 * means letters are piling up in the queue (spec §9), not that the api is unhealthy.
 */
export async function healthRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.get('/api/health', { config: { public: true } }, async (_req, reply) => {
    const db = await pingDb(opts.db);
    const lastOk = db ? await smtpLastOkAt(opts.db) : null;
    return reply.code(db ? 200 : 503).send({ db, smtpLastOkAt: lastOk });
  });
}
