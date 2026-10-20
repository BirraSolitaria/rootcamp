import { ChangePasswordBody, PatchMeBody } from '@rootcamp/api-contract';
import { users } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../plugins/errors.js';
import { SESSION_COOKIE } from '../plugins/session.js';
import { getMe, updateMe } from '../services/me.js';
import { revokeAllSessions } from '../services/sessions.js';
import { findUserById, hashPassword, toUserDto, verifyPassword } from '../services/users.js';
import { sendTokenEmail, type AuthRouteDeps } from './auth.js';

/** `GET|PATCH /api/me`, `POST /api/me/password`. All require a session. */
export async function meRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  const { db, now, verifyLetters } = deps;

  app.get('/api/me', async (req) => getMe(db, req.user!.id, now()));

  app.patch('/api/me', async (req) => {
    const sessionUser = req.user!;
    const patch = PatchMeBody.parse(req.body);
    // The current address (case-insensitive) is a no-op: no new token, no letter.
    if (
      patch.email !== undefined &&
      patch.email.toLowerCase() === sessionUser.email.toLowerCase()
    ) {
      delete patch.email;
    }
    // A new address means a verify letter: same per-user budget as resend-verification.
    // (A confirmed user gets 409 from updateMe and spends nothing.)
    const at = now();
    if (
      patch.email !== undefined &&
      !sessionUser.emailVerified &&
      !verifyLetters.hit(sessionUser.id, at)
    ) {
      throw new HttpError(429, 'rate_limited', 'too many letters, try again later');
    }
    const { user, verifyToken } = await updateMe(db, sessionUser.id, patch, at);
    if (verifyToken) await sendTokenEmail(deps, 'verify', user, verifyToken, req.log);
    return { user: toUserDto(user) };
  });

  // Checks `current`, sets `next` and signs out every other session (this one stays).
  app.post('/api/me/password', async (req, reply) => {
    const body = ChangePasswordBody.parse(req.body);
    const user = await findUserById(db, req.user!.id);
    if (!user) throw new HttpError(401, 'unauthorized', 'sign in required');
    if (!(await verifyPassword(user.passwordHash, body.current))) {
      throw new HttpError(400, 'wrong_password', 'current password is wrong');
    }
    const passwordHash = await hashPassword(body.next);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      await revokeAllSessions(tx, user.id, req.cookies[SESSION_COOKIE]);
    });
    return reply.code(204).send();
  });
}
