import { describe, expect, it } from 'vitest';
import {
  WS_CLOSE_REASONS,
  WS_CLOSE_SILENT,
  WS_CLOSE_TOO_MANY,
  closeCodeFor,
} from '@rootcamp/api-contract';
import {
  TicketError,
  signTicket,
  verifyTicket,
  type TicketPayload,
} from '@rootcamp/api-contract/ticket';

const SECRET = 'test-secret-0123456789abcdef';
const NOW = 1_800_000_000_000;

const payload: TicketPayload = {
  runId: '6f1c2a4e-8b3d-4c1a-9e2f-0a1b2c3d4e5f',
  userId: '0a1b2c3d-4e5f-4c1a-9e2f-6f1c2a4e8b3d',
  sandboxId: '9e2f0a1b-2c3d-4e5f-8b3d-6f1c2a4e4c1a',
  exp: NOW + 30_000,
  jti: 'b1c2d3e4-0000-4000-8000-000000000001',
};

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

describe('terminal tickets', () => {
  it('a signed ticket verifies back to its payload', () => {
    const token = signTicket(payload, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyTicket(token, SECRET, NOW)).toEqual(payload);
  });

  it('the payload part is base64url(json)', () => {
    const [body] = signTicket(payload, SECRET).split('.');
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))).toEqual(payload);
  });

  it('a changed payload byte → bad_sig', () => {
    const token = signTicket(payload, SECRET);
    const [body, sig] = token.split('.') as [string, string];
    const bytes = Buffer.from(body, 'base64url');
    bytes[5] = bytes[5]! ^ 1;
    const err = errorOf(() => verifyTicket(`${bytes.toString('base64url')}.${sig}`, SECRET, NOW));
    expect(err).toBeInstanceOf(TicketError);
    expect((err as TicketError).code).toBe('bad_sig');
  });

  it('a wrong secret, a truncated signature or garbage → bad_sig', () => {
    const token = signTicket(payload, SECRET);
    for (const bad of [
      () => verifyTicket(token, 'other-secret', NOW),
      () => verifyTicket(token.slice(0, -2), SECRET, NOW),
      () => verifyTicket(`${token}!`, SECRET, NOW),
      () => verifyTicket('garbage', SECRET, NOW),
      () => verifyTicket('', SECRET, NOW),
    ]) {
      const err = errorOf(bad);
      expect(err).toBeInstanceOf(TicketError);
      expect((err as TicketError).code).toBe('bad_sig');
    }
  });

  it('exp in the past → expired', () => {
    const token = signTicket({ ...payload, exp: NOW - 1 }, SECRET);
    const err = errorOf(() => verifyTicket(token, SECRET, NOW));
    expect(err).toBeInstanceOf(TicketError);
    expect((err as TicketError).code).toBe('expired');
  });
});

describe('WS close codes', () => {
  it('closed → 4000 + index of the reason', () => {
    expect(closeCodeFor('expired')).toBe(4000);
    expect(closeCodeFor('banned')).toBe(4008);
    expect(WS_CLOSE_REASONS).toEqual([
      'expired',
      'stopped_by_admin',
      'stopped_by_user',
      'sandbox_failed',
      'reset',
      'idle',
      'solved',
      'disk_quota',
      'banned',
    ]);
    expect(WS_CLOSE_SILENT).toBe(4100);
    expect(WS_CLOSE_TOO_MANY).toBe(4409);
  });
});
