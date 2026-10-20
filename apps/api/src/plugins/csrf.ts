import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { HttpError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard (spec §5.1): every mutating request needs `X-RC: 1` and an `Origin` equal to
 * `PUBLIC_ORIGIN`; otherwise `403 csrf`. Works together with the SameSite=Lax session cookie.
 */
export default fp(
  async function csrf(app: FastifyInstance, opts: { publicOrigin: string }) {
    app.addHook('onRequest', async (req) => {
      if (SAFE_METHODS.has(req.method)) return;
      if (req.headers['x-rc'] !== '1') {
        throw new HttpError(403, 'csrf', 'missing X-RC header');
      }
      if (req.headers.origin !== opts.publicOrigin) {
        throw new HttpError(403, 'csrf', 'origin mismatch');
      }
    });
  },
  { name: 'rc-csrf' },
);
