import { randomBytes } from 'node:crypto';
import { emailTokens } from '@rootcamp/db';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { HttpError } from '../plugins/errors.js';
import type { Executor } from './executor.js';
import { hashToken } from './sessions.js';

export type EmailTokenKind = 'verify' | 'reset';

/** Link lifetimes (Global Constraints): verify 24 h, reset 1 h. */
export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenKind, number> = {
  verify: 24 * 3600_000,
  reset: 3600_000,
};

/** Deletes the user's unused tokens of `kind`: their links stop working (`token_invalid`). */
export async function revokeEmailTokens(
  db: Executor,
  userId: string,
  kind: EmailTokenKind,
): Promise<void> {
  await db
    .delete(emailTokens)
    .where(
      and(eq(emailTokens.userId, userId), eq(emailTokens.kind, kind), isNull(emailTokens.usedAt)),
    );
}

/**
 * Issues a one-time token of `kind` for the user and returns it (32 random bytes, base64url).
 * Only its sha256 is stored. Earlier unused tokens of the same kind are revoked, so only the
 * newest link works.
 */
export async function issueEmailToken(
  db: Executor,
  userId: string,
  kind: EmailTokenKind,
  now: number,
): Promise<string> {
  await revokeEmailTokens(db, userId, kind);
  const token = randomBytes(32).toString('base64url');
  await db.insert(emailTokens).values({
    userId,
    kind,
    tokenHash: hashToken(token),
    expiresAt: new Date(now + EMAIL_TOKEN_TTL_MS[kind]),
  });
  return token;
}

/**
 * Marks the token used and returns its owner. A token is valid up to and including its
 * `expires_at`. Errors: `400 token_invalid` (unknown or other kind), `409 token_used`,
 * `400 token_expired`. Consumption is one conditional UPDATE, so a token is used at most once
 * even under concurrent requests.
 */
export async function consumeEmailToken(
  db: Executor,
  token: string,
  kind: EmailTokenKind,
  now: number,
): Promise<{ userId: string }> {
  const tokenHash = hashToken(token);
  const at = new Date(now);
  const [used] = await db
    .update(emailTokens)
    .set({ usedAt: at })
    .where(
      and(
        eq(emailTokens.tokenHash, tokenHash),
        eq(emailTokens.kind, kind),
        isNull(emailTokens.usedAt),
        gte(emailTokens.expiresAt, at),
      ),
    )
    .returning({ userId: emailTokens.userId });
  if (used) return used;

  await checkEmailToken(db, token, kind, now);
  // The token looked usable but the UPDATE missed: another request consumed it in between.
  throw new HttpError(409, 'token_used', 'link was already used');
}

/**
 * Read-only pre-check: throws the error `consumeEmailToken` would for an unusable token
 * (`400 token_invalid`, `409 token_used`, `400 token_expired`) and changes nothing. A token that
 * passes may still lose a race, so `consumeEmailToken` stays the one-time authority.
 */
export async function checkEmailToken(
  db: Executor,
  token: string,
  kind: EmailTokenKind,
  now: number,
): Promise<void> {
  const [row] = await db
    .select({ usedAt: emailTokens.usedAt, expiresAt: emailTokens.expiresAt })
    .from(emailTokens)
    .where(and(eq(emailTokens.tokenHash, hashToken(token)), eq(emailTokens.kind, kind)));
  if (!row) throw new HttpError(400, 'token_invalid', 'link is invalid');
  if (row.usedAt) throw new HttpError(409, 'token_used', 'link was already used');
  if (row.expiresAt.getTime() < now) throw new HttpError(400, 'token_expired', 'link has expired');
}
