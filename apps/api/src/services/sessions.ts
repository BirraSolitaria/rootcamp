import { createHash, randomBytes } from 'node:crypto';
import { sessions, users, type Db } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import type { Executor } from './executor.js';

/** Session lifetime; the cookie Max-Age matches it. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Activity extends a session at most once per this interval. */
export const RENEW_AFTER_MS = 3600_000;

export interface SessionUser {
  id: string;
  email: string;
  nick: string;
  isAdmin: boolean;
  emailVerified: boolean;
  status: 'active' | 'banned';
  tz: string;
}

/** Session row id: sha256 hex of the cookie token. The token itself is never stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a session valid for 30 days and returns its token (32 random bytes, base64url). */
export async function createSession(
  db: Executor,
  userId: string,
  ip: string | null,
  ua: string | null,
  now: number,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    createdAt: new Date(now),
    expiresAt: new Date(now + SESSION_TTL_MS),
    ip,
    userAgent: ua,
  });
  return token;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export type SessionLookup =
  { kind: 'none' } | { kind: 'expired' } | { kind: 'ok'; user: SessionUser; renewed: boolean };

/**
 * Resolves a cookie token to its user. Expired sessions are deleted. A live session is
 * extended to `now + 30d` when more than an hour passed since it was last extended.
 */
export async function resolveSession(db: Db, token: string, now: number): Promise<SessionLookup> {
  const id = hashToken(token);
  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      id: users.id,
      email: users.email,
      nick: users.nick,
      isAdmin: users.isAdmin,
      emailVerifiedAt: users.emailVerifiedAt,
      status: users.status,
      tz: users.tz,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id));
  if (!row) return { kind: 'none' };

  const expiresAt = row.expiresAt.getTime();
  if (expiresAt <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return { kind: 'expired' };
  }

  const lastRenewal = expiresAt - SESSION_TTL_MS;
  const renewed = now - lastRenewal > RENEW_AFTER_MS;
  if (renewed) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(sessions.id, id));
  }

  const user: SessionUser = {
    id: row.id,
    email: row.email,
    nick: row.nick,
    isAdmin: row.isAdmin,
    emailVerified: row.emailVerifiedAt !== null,
    status: row.status,
    tz: row.tz,
  };
  return { kind: 'ok', renewed, user };
}
