import type { Db } from '@rootcamp/db';
import type { FastifyInstance } from 'fastify';

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

/** `GET /api/health` → 200 `{db: true}` or 503 `{db: false}`; used by the compose healthcheck. */
export async function healthRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.get('/api/health', { config: { public: true } }, async (_req, reply) => {
    const db = await pingDb(opts.db);
    return reply.code(db ? 200 : 503).send({ db });
  });
}
