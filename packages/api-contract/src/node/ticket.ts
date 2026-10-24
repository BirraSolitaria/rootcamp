// Terminal tickets (spec §5.2): HMAC-SHA256 with the secret shared by `api` and `sandboxd`.
// Node-only (node:crypto), so it is the separate subpath `@rootcamp/api-contract/ticket` and is
// never reached from the browser bundle through the main entry.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const TicketPayload = z.object({
  runId: z.string(),
  userId: z.string(),
  sandboxId: z.string(),
  /** Expiry, epoch milliseconds (same clock as `now` of `verifyTicket`). */
  exp: z.number(),
  /** Single-use id; `sandboxd` remembers seen ones for 2 minutes. */
  jti: z.string(),
});
export type TicketPayload = z.infer<typeof TicketPayload>;

export type TicketErrorCode = 'bad_sig' | 'expired';

export class TicketError extends Error {
  constructor(readonly code: TicketErrorCode) {
    super(`ticket ${code}`);
    this.name = 'TicketError';
  }
}

function mac(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

/** `base64url(json).base64url(hmac-sha256(base64url(json)))`. */
export function signTicket(p: TicketPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
  return `${body}.${mac(body, secret).toString('base64url')}`;
}

/** Checks the signature, then `exp > now`. Throws `TicketError('bad_sig' | 'expired')`. */
export function verifyTicket(token: string, secret: string, now: number): TicketPayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new TicketError('bad_sig');
  const [body, sig] = parts as [string, string];
  const expected = mac(body, secret);
  const given = Buffer.from(sig, 'base64url');
  // Buffer's base64url decoder skips junk characters; require the canonical spelling.
  if (
    given.toString('base64url') !== sig ||
    given.length !== expected.length ||
    !timingSafeEqual(given, expected)
  ) {
    throw new TicketError('bad_sig');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new TicketError('bad_sig');
  }
  const payload = TicketPayload.safeParse(parsed);
  if (!payload.success) throw new TicketError('bad_sig');
  if (payload.data.exp <= now) throw new TicketError('expired');
  return payload.data;
}
