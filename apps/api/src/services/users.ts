import { randomUUID } from 'node:crypto';
import type { RegisterBody, UserDto } from '@rootcamp/api-contract';
import { hearts, streaks, users, type Db } from '@rootcamp/db';
import { isValidTimeZone } from '@rootcamp/logic';
import argon2 from 'argon2';
import { count, eq } from 'drizzle-orm';
import { HttpError } from '../plugins/errors.js';
import { issueEmailToken } from './emailTokens.js';
import type { Executor } from './executor.js';
import { createSession } from './sessions.js';
import { getSetting, lockRegistrationMode, setSetting } from './settings.js';

export type User = typeof users.$inferSelect;

export interface Registration {
  user: User;
  /** Cookie token of the session opened for the new user. */
  sessionToken: string;
  /** Plain verify token for the confirmation link (only its hash is stored). */
  verifyToken: string;
}

export interface ClientInfo {
  ip: string | null;
  ua: string | null;
}

/** pg `time` comes back as `HH:MM:SS`; the contract wants `HH:MM`. */
function hhmm(time: string): string {
  return time.slice(0, 5);
}

export function toUserDto(u: User): UserDto {
  return {
    id: u.id,
    email: u.email,
    nick: u.nick,
    emailVerified: u.emailVerifiedAt !== null,
    isAdmin: u.isAdmin,
    tz: u.tz,
    rank: u.rank,
    totalXp: u.totalXp,
    reminderEnabled: u.reminderEnabled,
    reminderTime: hhmm(u.reminderTime),
  };
}

/** What a honeypot hit gets back: shaped like a real new user, backed by nothing. */
export function decoyUserDto(body: RegisterBody): UserDto {
  return {
    id: randomUUID(),
    email: body.email.toLowerCase(),
    nick: body.nick,
    emailVerified: false,
    isAdmin: false,
    tz: body.tz,
    rank: 'guest',
    totalXp: 0,
    reminderEnabled: true,
    reminderTime: '20:00',
  };
}

export async function findUserById(db: Executor, id: string): Promise<User | undefined> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u;
}

/** Lookup by email; `users.email` is citext, so the match is case-insensitive. */
export async function findUserByEmail(db: Executor, email: string): Promise<User | undefined> {
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return u;
}

/** argon2id with the library's default parameters. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** False (never throws) for a wrong password or a malformed hash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Computes the dummy hash ahead of the first login so that one is not slower. Idempotent. */
export function primeDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('rootcamp dummy password');
  return dummyHash;
}

/**
 * Checks email + password. An unknown email is still verified against a dummy argon2id hash, so
 * both failures take the same time; the caller answers both with the same 401.
 */
export async function checkCredentials(
  db: Executor,
  email: string,
  password: string,
): Promise<User | null> {
  const user = await findUserByEmail(db, email);
  const ok = await verifyPassword(user?.passwordHash ?? (await primeDummyHash()), password);
  return user && ok ? user : null;
}

const UNIQUE_CONSTRAINT_CODES: Record<string, 'email_taken' | 'nick_taken'> = {
  users_email_unique: 'email_taken',
  users_nick_unique: 'nick_taken',
};

/** Maps a unique violation (23505) on users.email / users.nick, possibly wrapped by drizzle. */
export function takenCode(err: unknown): 'email_taken' | 'nick_taken' | undefined {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    const pg = e as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (pg.code === '23505' && typeof pg.constraint_name === 'string') {
      return UNIQUE_CONSTRAINT_CODES[pg.constraint_name];
    }
    e = pg.cause;
  }
  return undefined;
}

/** `website` is a honeypot: any non-empty value marks a bot. */
export function isHoneypot(body: RegisterBody): boolean {
  return body.website !== undefined && body.website !== '';
}

/**
 * Registers a user (spec §5.1). Returns null for a honeypot hit (nothing is created).
 * One transaction, serialised on the `registration_mode` row: checks the mode
 * (`403 registration_closed`) and `max_users` — when the count has reached it the mode is
 * switched to `closed` (committed) and `403 user_limit` is thrown — then creates the user with
 * `hearts(5)`, `streaks(0,0,null)`, a session and a verify token. Email is citext, so
 * `Ann@Mail.ru` collides with `ann@mail.ru` → `409 email_taken`; nick → `409 nick_taken`
 * (unique violations, so concurrent registrations are covered too). Unknown tz → `400 validation`.
 *
 * Takes the session's client info in addition to the plan's `(db, body, now)` because the
 * session is created in the same transaction.
 */
export async function registerUser(
  db: Db,
  body: RegisterBody,
  now: number,
  client: ClientInfo = { ip: null, ua: null },
): Promise<Registration | null> {
  if (isHoneypot(body)) return null;
  if (!isValidTimeZone(body.tz)) throw new HttpError(400, 'validation', 'tz: unknown time zone');

  const passwordHash = await hashPassword(body.password);

  let outcome: Registration | 'closed' | 'limit';
  try {
    outcome = await db.transaction(async (tx) => {
      if ((await lockRegistrationMode(tx)) === 'closed') return 'closed' as const;
      const maxUsers = Number(await getSetting(tx, 'max_users', 50));
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(users);
      if (n >= maxUsers) {
        await setSetting(tx, 'registration_mode', 'closed');
        return 'limit' as const;
      }

      const at = new Date(now);
      const [user] = await tx
        .insert(users)
        .values({
          email: body.email.toLowerCase(),
          nick: body.nick,
          passwordHash,
          tz: body.tz,
          createdAt: at,
        })
        .returning();
      await tx.insert(hearts).values({ userId: user!.id, count: 5, lastRegenAt: at });
      await tx.insert(streaks).values({ userId: user!.id, current: 0, best: 0 });
      const sessionToken = await createSession(tx, user!.id, client.ip, client.ua, now);
      const verifyToken = await issueEmailToken(tx, user!.id, 'verify', now);
      return { user: user!, sessionToken, verifyToken };
    });
  } catch (err) {
    const code = takenCode(err);
    if (code) {
      throw new HttpError(409, code, code === 'email_taken' ? 'email is taken' : 'nick is taken');
    }
    throw err;
  }

  if (outcome === 'closed')
    throw new HttpError(403, 'registration_closed', 'registration is closed');
  if (outcome === 'limit') throw new HttpError(403, 'user_limit', 'user limit reached');
  return outcome;
}
