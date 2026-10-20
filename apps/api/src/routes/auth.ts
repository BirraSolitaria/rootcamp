import { ForgotBody, LoginBody, RegisterBody, ResetBody, VerifyBody } from '@rootcamp/api-contract';
import { users } from '@rootcamp/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { resetEmail, tokenLink, verifyEmail } from '../mail/templates.js';
import { HttpError } from '../plugins/errors.js';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from '../plugins/session.js';
import { consumeEmailToken, issueEmailToken } from '../services/emailTokens.js';
import { createLimiter, limitSpec } from '../services/limiter.js';
import { enqueueEmail } from '../services/mailer.js';
import { createSession, revokeAllSessions, revokeSession } from '../services/sessions.js';
import {
  checkCredentials,
  decoyUserDto,
  findUserByEmail,
  findUserById,
  hashPassword,
  primeDummyHash,
  registerUser,
  toUserDto,
} from '../services/users.js';

export type AuthDeps = Pick<AppDeps, 'config' | 'db' | 'now' | 'mailer' | 'boss' | 'limits'>;

/** Renders the `verify`/`reset` letter for `token` and hands it to `enqueueEmail`. */
export async function sendTokenEmail(
  deps: AuthDeps,
  kind: 'verify' | 'reset',
  user: { id: string; email: string },
  token: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const link = tokenLink(deps.config.PUBLIC_ORIGIN, kind, token);
  const letter = kind === 'verify' ? verifyEmail(link) : resetEmail(link);
  await enqueueEmail(
    deps.boss,
    deps.db,
    { userId: user.id, kind, to: user.email, ...letter },
    { mailer: deps.mailer, now: deps.now, log },
  );
}

/** `/api/auth/*`: register, verify, resend-verification, login, logout, forgot, reset. */
export async function authRoutes(app: FastifyInstance, deps: AuthDeps) {
  const { config, db, now } = deps;
  // Per app instance: a rebuilt app (harness reset) starts with clean counters.
  const resendMinute = createLimiter(limitSpec('resendVerificationMinute', deps.limits));
  const resendDay = createLimiter(limitSpec('resendVerificationDay', deps.limits));
  // So the first login with an unknown email is not slower than the rest.
  await primeDummyHash();

  app.post('/api/auth/register', { config: { public: true } }, async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    const reg = await registerUser(db, body, now(), {
      ip: req.ip,
      ua: req.headers['user-agent'] ?? null,
    });
    if (!reg) return reply.code(201).send({ user: decoyUserDto(body) });

    setSessionCookie(reply, reg.sessionToken, config);
    await sendTokenEmail(deps, 'verify', reg.user, reg.verifyToken, req.log);
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
    await sendTokenEmail(deps, 'verify', user, token, req.log);
    return reply.code(204).send();
  });

  // Unknown email and wrong password: the same 401 after the same argon2 work.
  // Rate limits (5/min per IP, 20/h per email) arrive with Task 7.
  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const user = await checkCredentials(db, body.email, body.password);
    if (!user) throw new HttpError(401, 'invalid_credentials', 'wrong email or password');
    if (user.status === 'banned') throw new HttpError(403, 'banned', 'account is banned');

    const ua = req.headers['user-agent'] ?? null;
    const token = await createSession(db, user.id, req.ip, ua, now());
    setSessionCookie(reply, token, config);
    return { user: toUserDto(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await revokeSession(db, token);
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  // Always 204: whether an account exists is not disclosed. Unknown email → no letter, no log.
  app.post('/api/auth/forgot', { config: { public: true } }, async (req, reply) => {
    const { email } = ForgotBody.parse(req.body);
    const user = await findUserByEmail(db, email);
    if (user && user.status === 'active') {
      const token = await issueEmailToken(db, user.id, 'reset', now());
      await sendTokenEmail(deps, 'reset', user, token, req.log);
    }
    return reply.code(204).send();
  });

  // One-time 1 h link; sets the new password and signs the user out everywhere.
  app.post('/api/auth/reset', { config: { public: true } }, async (req, reply) => {
    const body = ResetBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    await db.transaction(async (tx) => {
      const { userId } = await consumeEmailToken(tx, body.token, 'reset', now());
      await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
      await revokeAllSessions(tx, userId);
    });
    return reply.code(204).send();
  });
}
