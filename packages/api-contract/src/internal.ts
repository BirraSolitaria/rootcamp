import { z } from 'zod';
import { WsCloseReason } from './ws.js';

// Internal API of `sandboxd` (spec §5.3): network `rc-internal` only, every request carries
// `Authorization: Bearer <INTERNAL_TOKEN>`. Times are ISO strings.

export const SandboxClass = z.enum(['light', 'docker', 'heavy']);
export type SandboxClass = z.infer<typeof SandboxClass>;

/** `queue_timeout` is `stopped` + `stopReason: 'queue_timeout'`. */
export const SandboxState = z.enum([
  'queued',
  'starting',
  'ready',
  'stopping',
  'stopped',
  'failed',
]);
export type SandboxState = z.infer<typeof SandboxState>;

/**
 * `POST /internal/sandboxes`. Beyond §5.3: `title` (written for the MOTD before setup) and
 * `test` (`practice:test`: outside the queue, `userId: null`, at most one at a time).
 */
export const CreateSandboxBody = z.object({
  runId: z.uuid(),
  userId: z.uuid().nullable(),
  image: z.string().min(1).max(200),
  class: SandboxClass,
  hostname: z.string().min(1).max(253),
  title: z.string().max(200),
  setupScript: z.string().max(100_000),
  setupTimeoutSec: z.number().int().positive(),
  ttlMin: z.number().int().positive().max(90),
  test: z.boolean().optional(),
});
export type CreateSandboxBody = z.infer<typeof CreateSandboxBody>;

export const SandboxUsageDto = z.object({
  cpuPct: z.number().nonnegative(),
  memMb: z.number().nonnegative(),
  memLimitMb: z.number().nonnegative(),
});
export type SandboxUsageDto = z.infer<typeof SandboxUsageDto>;

/** Answer of `POST /internal/sandboxes` and `GET /internal/sandboxes/:id`. */
export const SandboxView = z.object({
  sandboxId: z.uuid(),
  state: SandboxState,
  stopReason: z.string().nullable(),
  /** 1-based place in the queue while `queued`, else null. */
  queuePosition: z.number().int().positive().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  hardDeadline: z.iso.datetime().nullable(),
  readyAt: z.iso.datetime().nullable(),
  canExtend: z.boolean(),
  /** Live CPU / RAM of a `ready` sandbox, else null. */
  usage: SandboxUsageDto.nullable(),
});
export type SandboxView = z.infer<typeof SandboxView>;

export const ExecCheck = z.object({
  goalId: z.string().min(1).max(200),
  script: z.string().max(100_000),
  timeoutSec: z.number().int().positive().max(40),
});
export type ExecCheck = z.infer<typeof ExecCheck>;

/** `POST /internal/sandboxes/:id/exec-checks`; checks run sequentially. */
export const ExecChecksBody = z.object({ checks: z.array(ExecCheck).min(1).max(50) });
export type ExecChecksBody = z.infer<typeof ExecChecksBody>;

export const ExecCheckResult = z.object({
  goalId: z.string(),
  /** Exit code of the script; 124 when it timed out (`timedOut: true`). */
  exitCode: z.number().int(),
  /** First 300 characters of stdout (UTF-8, invalid bytes replaced). */
  output: z.string(),
  timedOut: z.boolean(),
});
export type ExecCheckResult = z.infer<typeof ExecCheckResult>;

export const ExecChecksResponse = z.array(ExecCheckResult);
export type ExecChecksResponse = z.infer<typeof ExecChecksResponse>;

/** `POST /internal/sandboxes/:id/extend` → this, or `409`. */
export const ExtendSandboxResponse = z.object({ expiresAt: z.iso.datetime() });
export type ExtendSandboxResponse = z.infer<typeof ExtendSandboxResponse>;

/** `DELETE /internal/sandboxes/:id`; the reason goes to open terminals as `{t:'closed'}`. */
export const DeleteSandboxBody = z.object({ reason: WsCloseReason });
export type DeleteSandboxBody = z.infer<typeof DeleteSandboxBody>;
