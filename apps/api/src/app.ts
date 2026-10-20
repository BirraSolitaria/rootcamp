import { randomBytes } from 'node:crypto';
import type { Db } from '@rootcamp/db';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Config } from './config.js';
import csrf from './plugins/csrf.js';
import errors from './plugins/errors.js';
import session from './plugins/session.js';
import verifiedGuard from './plugins/verifiedGuard.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { createVerifyLetterLimiter } from './services/limiter.js';
import type { ContentStore, Limits, Mailer, PgBoss, SandboxdClient } from './types.js';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Clock in epoch ms; tests inject a controllable one. */
  now: () => number;
  mailer: Mailer;
  /** pg-boss (`jobs/boss.ts`); null → emails are sent inline, one attempt (tests, R-M2-1). */
  boss: PgBoss | null;
  /** Rate-limit overrides (R-M2-3); production values when omitted. */
  limits?: Limits;
  /** Fastify logger option; default: off. */
  logger?: FastifyServerOptions['logger'];
  /** A ready logger instance (server.ts shares its pino logger with pg-boss); wins over `logger`. */
  loggerInstance?: FastifyBaseLogger;
  sandboxd?: SandboxdClient /* M4a */;
  content?: ContentStore /* M3 */;
}

/** Short random request id: shown to users in 500 messages and logged by pino. */
const genReqId = () => randomBytes(6).toString('hex');

/**
 * Builds the api: error mapping → CSRF → session (401 on non-public routes) → verified-email
 * guard, then routes. Hooks run in this order on every request. Not yet `ready()`: callers may
 * add routes before the first `inject`/`listen`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    ...(deps.loggerInstance
      ? { loggerInstance: deps.loggerInstance }
      : { logger: deps.logger ?? false }),
    genReqId,
    // Exactly one proxy (Caddy) in front: `req.ip` is the address Caddy saw, not a value a
    // client could inject with its own X-Forwarded-For.
    // (Fastify's typings lack the numeric hop form, so: trust only hop 0.)
    trustProxy: (_address: string, hop: number) => hop < 1,
  });

  await app.register(errors);
  await app.register(csrf, { publicOrigin: deps.config.PUBLIC_ORIGIN });
  await app.register(session, { db: deps.db, config: deps.config, now: deps.now });
  await app.register(verifiedGuard);

  await app.register(healthRoutes, { db: deps.db });
  // Shared so an email change cannot bypass the resend-verification limit.
  const verifyLetters = createVerifyLetterLimiter(deps.limits);
  await app.register(authRoutes, { ...deps, verifyLetters });
  await app.register(meRoutes, { ...deps, verifyLetters });

  return app;
}
