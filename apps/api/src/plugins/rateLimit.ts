import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Limiter, Limiters } from '../services/limiter.js';
import { rateLimited } from './errors.js';

/** Per-IP route limits (spec §6.3); set with `config: { rateLimit: 'login' }`. */
export type RouteLimit = 'login' | 'register' | 'forgot';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Extra per-IP limit checked before the handler, on top of the global one. */
    rateLimit?: RouteLimit;
  }
}

export interface RateLimitPluginOpts {
  limiters: Limiters;
  now: () => number;
}

/** Not counted by the global limit: container and uptime probes poll it. */
const UNLIMITED_URLS = new Set(['/api/health']);

/** Records a hit or throws `429 rate_limited` with `Retry-After`. */
export function enforce(limiter: Limiter, key: string, now: number, message?: string): void {
  if (!limiter.hit(key, now)) throw rateLimited(limiter.retryAfterMs(key, now), message);
}

/**
 * Request rate limits, all in-memory sliding windows on the app's clock (`deps.now`):
 * - global 300/min keyed by `userId ?? ip` (runs after `session`, so `req.user` is known);
 * - per-IP route limits from `config.rateLimit` (login, register, forgot), checked before the
 *   body is parsed, so a refused register never reaches argon2.
 * Per-key limits that need the body or the user (login per email, password change, verify
 * letters) are enforced in their handlers with `enforce`.
 *
 * `req.ip` relies on `TRUST_PROXY_HOPS` (see config.ts): behind exactly one proxy that sets
 * X-Forwarded-For (Caddy), it is the client address Caddy saw.
 */
export default fp(
  async function rateLimit(app: FastifyInstance, opts: RateLimitPluginOpts) {
    const { limiters, now } = opts;
    const routeLimiters: Record<RouteLimit, Limiter> = {
      login: limiters.loginIp,
      register: limiters.registerIp,
      forgot: limiters.forgotIp,
    };

    app.addHook('onRequest', async (req) => {
      if (UNLIMITED_URLS.has(req.routeOptions.url ?? '')) return;
      const at = now();
      enforce(limiters.api, req.user ? `u:${req.user.id}` : `ip:${req.ip}`, at);
      const route = req.is404 ? undefined : req.routeOptions.config.rateLimit;
      if (route) enforce(routeLimiters[route], req.ip, at);
    });
  },
  { name: 'rc-rate-limit', dependencies: ['rc-errors', 'rc-session'] },
);
