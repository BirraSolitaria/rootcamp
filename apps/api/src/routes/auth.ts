import { RegisterBody, VerifyBody } from '@rootcamp/api-contract';
import { users } from '@rootcamp/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { tokenLink, verifyEmail } from '../mail/templates.js';
import { HttpError } from '../plugins/errors.js';
import { setSessionCookie } from '../plugins/session.js';
import { consumeEmailToken, issueEmailToken } from '../services/emailTokens.js';
import { createLimiter, limitSpec } from '../services/limiter.js';
import { enqueueEmail } from '../services/mailer.js';
import { decoyUserDto, findUserById, registerUser, toUserDto } from '../services/users.js';

type AuthDeps = Pick<AppDeps, 'config' | 'db' | 'now' | 'mailer' | 'boss' | 'limits'>;

/** `/api/auth/*`: register, verify, resend-verification (login/logout/forgot/reset: Task 5). */
export async function authRoutes(app: FastifyInstance, deps: AuthDeps) {
  const { config, db, now } = deps;
  // Per app instance: a rebuilt app (harness reset) starts with clean counters.
  const resendMinute = createLimiter(limitSpec('resendVerificationMinute', deps.limits));
  const resendDay = createLimiter(limitSpec('resendVerificationDay', deps.limits));

  async function sendVerifyEmail(
    userId: string,
    to: string,
    token: string,
    log: FastifyInstance['log'],
  ) {
    const letter = verifyEmail(tokenLink(config.PUBLIC_ORIGIN, 'verify', token));
    await enqueueEmail(
      deps.boss,
      db,
      { userId, kind: 'verify', to, ...letter },
      { mailer: deps.mailer, now, log },
    );
  }

  app.post('/api/auth/register', { config: { public: true } }, async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    const reg = await registerUser(db, body, now(), {
      ip: req.ip,
      ua: req.headers['user-agent'] ?? null,
    });
    if (!reg) return reply.code(201).send({ user: decoyUserDto(body) });

    setSessionCookie(reply, reg.sessionToken, config);
    await sendVerifyEmail(reg.user.id, reg.user.email, reg.verifyToken, req.log);
    return reply.code(201).send({ user: toUserDto(reg.user) });
  });

  app.post('/api/auth/verify', { config: { public: true } }, async (req) => {
    const { token } = VerifyBody.parse(req.body);
    const at = now();
    const user = await db.transaction(async (tx) => {
      const { userId } = await consumeEmailToken(tx, token, 'verify', at);
      const [u] = await tx
        .update(users)
        .set({ emailVerifiedAt: new Date(at) })
        .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)))
        .returning();
      // Already verified (e.g. through another link or by an admin): same answer as a reused
      // link; the client shows success.
      if (!u) throw new HttpError(409, 'token_used', 'email is already verified');
      return u;
    });
    return { user: toUserDto(user) };
  });

  app.post('/api/auth/resend-verification', async (req, reply) => {
    const sessionUser = req.user!;
    if (sessionUser.emailVerified) {
      throw new HttpError(409, 'email_already_verified', 'email is already verified');
    }
    const at = now();
    if (!resendMinute.hit(sessionUser.id, at) || !resendDay.hit(sessionUser.id, at)) {
      throw new HttpError(429, 'rate_limited', 'too many letters, try again later');
    }
    const user = await findUserById(db, sessionUser.id);
    if (!user) throw new HttpError(401, 'unauthorized', 'sign in required');
    const token = await issueEmailToken(db, user.id, 'verify', at);
    await sendVerifyEmail(user.id, user.email, token, req.log);
    return reply.code(204).send();
  });
}
