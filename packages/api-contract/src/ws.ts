import { z } from 'zod';

/**
 * Reasons of the `{t:'closed'}` frame (spec §5.2), in this exact order: after `closed` the server
 * closes the socket with `4000 + index` (`closeCodeFor`).
 */
export const WS_CLOSE_REASONS = [
  'expired',
  'stopped_by_admin',
  'stopped_by_user',
  'sandbox_failed',
  'reset',
  'idle',
  'solved',
  'disk_quota',
  'banned',
] as const;
export const WsCloseReason = z.enum(WS_CLOSE_REASONS);
export type WsCloseReason = z.infer<typeof WsCloseReason>;

/** WebSocket close code that follows `{t:'closed', reason}`. */
export function closeCodeFor(reason: WsCloseReason): number {
  return 4000 + WS_CLOSE_REASONS.indexOf(reason);
}

/** 60 s without client frames (§5.2 says 4008, which collides with `banned`). */
export const WS_CLOSE_SILENT = 4100;
/** Bad / expired / reused ticket, or the sandbox is not `ready` for this user (before `ready`). */
export const WS_CLOSE_UNAUTHORIZED = 4401;
/** A third connection to one sandbox. */
export const WS_CLOSE_TOO_MANY = 4409;

/** Client → server text frames. Binary frames are raw input, ≤ 4 KB each. */
export const ClientCtl = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('resize'),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientCtl = z.infer<typeof ClientCtl>;

/** Server → client text frames. Binary frames are TTY output. */
export const ServerCtl = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready') }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('expiring'), secondsLeft: z.number().int().nonnegative() }),
  z.object({ t: z.literal('extended'), expiresAt: z.iso.datetime() }),
  z.object({ t: z.literal('closed'), reason: WsCloseReason }),
]);
export type ServerCtl = z.infer<typeof ServerCtl>;
