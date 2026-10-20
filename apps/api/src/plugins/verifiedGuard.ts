import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { HttpError } from './errors.js';

/**
 * Routes a signed-in user with an unconfirmed email may call (spec §5.1, plan Task 3):
 * `/api/auth/*`, `GET|PATCH /api/me`, `/api/health`, `GET /api/content/version`.
 * `url` is the route pattern, not the raw request path.
 */
export function allowedWhileUnverified(method: string, url: string): boolean {
  const m = method === 'HEAD' ? 'GET' : method;
  if (url.startsWith('/api/auth/')) return true;
  if (url === '/api/health') return true;
  if (url === '/api/me') return m === 'GET' || m === 'PATCH';
  if (url === '/api/content/version') return m === 'GET';
  return false;
}

/** `403 email_unverified` for an unverified user outside the allow-list. Runs after `session`. */
export default fp(
  async function verifiedGuard(app: FastifyInstance) {
    app.addHook('onRequest', async (req) => {
      const user = req.user;
      if (!user || user.emailVerified || req.is404) return;
      if (!allowedWhileUnverified(req.method, req.routeOptions.url ?? '')) {
        throw new HttpError(403, 'email_unverified', 'confirm your email first');
      }
    });
  },
  { name: 'rc-verified-guard', dependencies: ['rc-session'] },
);
