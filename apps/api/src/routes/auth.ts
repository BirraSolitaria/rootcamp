import { ForgotBody, LoginBody, RegisterBody, ResetBody, VerifyBody } from '@rootcamp/api-contract';
import { users } from '@rootcamp/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { resetEmail, tokenLink, verifyEmail } from '../mail/templates.js';
import { HttpError } from '../plugins/errors.js';
import { enforce } from '../plugins/rateLimit.js';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from '../plugins/session.js';
import { checkEmailToken, consumeEmailToken, issueEmailToken } from '../services/emailTokens.js';
import type { Limiters } from '../services/limiter.js';
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

/** Route deps: the app's deps plus its rate limiters (shared by auth and me routes). */
export type AuthRouteDeps = AuthDeps & { limiters: Limiters };

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
export async function authRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  const { config, db, now, limiters } = deps;
  // So the first login with an unknown email is not slower than the rest.
  await primeDummyHash();

  // 3/h per IP (rate-limit plugin, before the body is read).
  app.post(
    '/api/auth/register',
    { config: { public: true, rateLimit: 'register' } },
    async (req, reply) => {
      const body = RegisterBody.parse(req.body);
      const reg = await registerUser(db, body, now(), {
        ip: req.ip,
        ua: req.headers['user-agent'] ?? null,
      });
      if (!reg) return reply.code(201).send({ user: decoyUserDto(body) });

      setSessionCookie(reply, reg.sessionToken, config);
      await sendTokenEmail(deps, 'verify', reg.user, reg.verifyToken, req.log);
      return reply.code(201).send({ user: toUserDto(reg.user) });
    },
  );

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
    // Per-user verify-letter budget, shared with `PATCH /api/me {email}`.
    enforce(limiters.verifyLetters, sessionUser.id, at, 'too many letters, try again later');
    const user = await findUserById(db, sessionUser.id);
    if (!user) throw new HttpError(401, 'unauthorized', 'sign in required');
    const token = await issueEmailToken(db, user.id, 'verify', at);
    await sendTokenEmail(deps, 'verify', user, token, req.log);
    return reply.code(204).send();
  });

  // Unknown email and wrong password: the same 401 after the same argon2 work.
  // Limits: 5/min per IP (plugin), then 20/h per lowercased email, counted before the
  // credentials are checked, so the 429 is the same whether or not the account exists.
  app.post(
    '/api/auth/login',
    { config: { public: true, rateLimit: 'login' } },
    async (req, reply) => {
      const body = LoginBody.parse(req.body);
      enforce(limiters.loginEmail, body.email.toLowerCase(), now());
      const user = await checkCredentials(db, body.email, body.password);
      if (!user) throw new HttpError(401, 'invalid_credentials', 'wrong email or password');
      if (user.status === 'banned') throw new HttpError(403, 'banned', 'account is banned');

      const ua = req.headers['user-agent'] ?? null;
      const token = await createSession(db, user.id, req.ip, ua, now());
      setSessionCookie(reply, token, config);
      return { user: toUserDto(user) };
    },
  );

  // Public: a missing, expired or stale cookie still gets 204 and is cleared.
  app.post('/api/auth/logout', { config: { public: true } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await revokeSession(db, token);
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  // Always 204: whether an account exists is not disclosed. Unknown email → no letter, no log.
  // 3/h per IP (rate-limit plugin).
  app.post(
    '/api/auth/forgot',
    { config: { public: true, rateLimit: 'forgot' } },
    async (req, reply) => {
      const { email } = ForgotBody.parse(req.body);
      const user = await findUserByEmail(db, email);
      if (user && user.status === 'active') {
        const token = await issueEmailToken(db, user.id, 'reset', now());
        await sendTokenEmail(deps, 'reset', user, token, req.log);
      }
      return reply.code(204).send();
    },
  );

  // One-time 1 h link; sets the new password and signs the user out everywhere.
  // 10/h per IP (rate-limit plugin). The token is checked before argon2 runs, so a bad link
  // costs no hashing; the conditional UPDATE in consumeEmailToken stays the one-time authority.
  app.post(
    '/api/auth/reset',
    { config: { public: true, rateLimit: 'reset' } },
    async (req, reply) => {
      const body = ResetBody.parse(req.body);
      await checkEmailToken(db, body.token, 'reset', now());
      const passwordHash = await hashPassword(body.password);
      await db.transaction(async (tx) => {
        const { userId } = await consumeEmailToken(tx, body.token, 'reset', now());
        await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
        await revokeAllSessions(tx, userId);
      });
      return reply.code(204).send();
    },
  );
}
