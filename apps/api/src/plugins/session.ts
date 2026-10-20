import cookie from '@fastify/cookie';
import type { Db } from '@rootcamp/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import type { Config } from '../config.js';
import {
  resolveSession,
  revokeAllSessions,
  SESSION_TTL_MS,
  type SessionUser,
} from '../services/sessions.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'rc_sid';

declare module 'fastify' {
  interface FastifyRequest {
    /** Signed-in user, or null. Set by the `session` plugin before any route runs. */
    user: SessionUser | null;
  }
  interface FastifyContextConfig {
    /** Route is reachable without a session (health, register, login, …). Default: false. */
    public?: boolean;
  }
}

type CookieConfig = Pick<Config, 'COOKIE_SECURE'>;

function cookieOptions(config: CookieConfig) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
  };
}

/** Sets `rc_sid`: HttpOnly, Secure (unless COOKIE_SECURE=false), SameSite=Lax, 30 days. */
export function setSessionCookie(reply: FastifyReply, token: string, config: CookieConfig): void {
  reply.setCookie(SESSION_COOKIE, token, {
    ...cookieOptions(config),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: CookieConfig): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

export interface SessionPluginOpts {
  db: Db;
  config: CookieConfig;
  now: () => number;
}

/**
 * Loads `request.user` from the `rc_sid` cookie, extends active sessions, drops expired ones,
 * rejects banned users (`403 banned`, all their sessions deleted) and answers `401
 * unauthorized` on every non-public route without a session.
 */
export default fp(
  async function session(app: FastifyInstance, opts: SessionPluginOpts) {
    await app.register(cookie);
    app.decorateRequest('user', null);

    app.addHook('onRequest', async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) {
        const found = await resolveSession(opts.db, token, opts.now());
        if (found.kind === 'ok') {
          if (found.user.status === 'banned') {
            await revokeAllSessions(opts.db, found.user.id);
            clearSessionCookie(reply, opts.config);
            throw new HttpError(403, 'banned', 'account is banned');
          }
          req.user = found.user;
          if (found.renewed) setSessionCookie(reply, token, opts.config);
        } else {
          clearSessionCookie(reply, opts.config);
        }
      }

      if (!req.user && !req.is404 && !req.routeOptions.config.public) {
        throw new HttpError(401, 'unauthorized', 'sign in required');
      }
    });
  },
  { name: 'rc-session', dependencies: ['rc-errors'] },
);
