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
import rateLimit from './plugins/rateLimit.js';
import session from './plugins/session.js';
import verifiedGuard from './plugins/verifiedGuard.js';
import { authRoutes } from './routes/auth.js';
import { contentRoutes } from './routes/content.js';
import { healthRoutes } from './routes/health.js';
import { lessonRoutes } from './routes/lessons.js';
import { reviewRoutes } from './routes/review.js';
import { meRoutes } from './routes/me.js';
import { practiceRoutes } from './routes/practices.js';
import { progressRoutes } from './routes/progress.js';
import { NO_CONTENT, type ContentHolder } from './services/contentStore.js';
import { createLimiters } from './services/limiter.js';
import { createRunService } from './services/runs.js';
import type { Limits, Mailer, PgBoss, SandboxdClient } from './types.js';

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
  /** sandboxd internal API; unset (no `SANDBOXD_URL`) → run routes answer 503, health says false. */
  sandboxd?: SandboxdClient;
  /**
   * Active course content (`services/contentStore.ts`); the caller owns its lifecycle
   * (`close()`). Omitted: content routes answer 503 and `GET /api/me` counts no tracks.
   */
  content?: ContentHolder;
}

/** Short random request id: shown to users in 500 messages and logged by pino. */
const genReqId = () => randomBytes(6).toString('hex');

/**
 * Builds the api: error mapping → CSRF → session (401 on non-public routes) → rate limits → verified-email
 * guard, then routes. Hooks run in this order on every request. Not yet `ready()`: callers may
 * add routes before the first `inject`/`listen`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    ...(deps.loggerInstance
      ? { loggerInstance: deps.loggerInstance }
      : { logger: deps.logger ?? false }),
    genReqId,
    // TRUST_PROXY_HOPS proxies (default 1: Caddy) in front: req.ip is the address the outermost
    // trusted proxy saw, never a value the client put into its own X-Forwarded-For.
    // (Fastify's typings lack the numeric hop form, so: trust hops below the configured count.)
    trustProxy: (_address: string, hop: number) => hop < deps.config.TRUST_PROXY_HOPS,
  });

  await app.register(errors);
  await app.register(csrf, { publicOrigin: deps.config.PUBLIC_ORIGIN });
  await app.register(session, { db: deps.db, config: deps.config, now: deps.now });
  // Per app instance: a rebuilt app starts with clean counters.
  const limiters = createLimiters(deps.limits);
  await app.register(rateLimit, { limiters, now: deps.now });
  await app.register(verifiedGuard);

  await app.register(healthRoutes, { db: deps.db, sandboxd: deps.sandboxd });
  await app.register(authRoutes, { ...deps, limiters });
  const content = deps.content ?? NO_CONTENT;
  await app.register(meRoutes, { ...deps, content, limiters });
  await app.register(contentRoutes, { content });
  await app.register(progressRoutes, { db: deps.db, now: deps.now, content });
  await app.register(lessonRoutes, { db: deps.db, now: deps.now, content });
  await app.register(reviewRoutes, { db: deps.db, now: deps.now, content });
  const runs = createRunService({
    db: deps.db,
    content,
    sandboxd: deps.sandboxd,
    boss: deps.boss,
    now: deps.now,
    ticketSecret: deps.config.TICKET_SECRET,
    publicOrigin: deps.config.PUBLIC_ORIGIN,
    limiters,
    log: app.log,
  });
  await app.register(practiceRoutes, { db: deps.db, content, runs });

  return app;
}
