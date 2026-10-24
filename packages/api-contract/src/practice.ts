import { z } from 'zod';
import { PracticeStatus } from './content.js';
import { SandboxUsageDto } from './internal.js';
import { LessonSummaryDto } from './learning.js';

// Practice endpoints of `api` (spec §5.1 «Практика») as seen by `web`. Times are ISO strings.

const Count = z.number().int().nonnegative();

/** `practice_runs.status`. */
export const RunState = z.enum([
  'queued',
  'starting',
  'ready',
  'solved',
  'expired',
  'stopped',
  'failed',
  'queue_timeout',
]);
export type RunState = z.infer<typeof RunState>;

/** An item of `GET /api/practices`. */
export const PracticeListItem = z.object({
  id: z.string(),
  title: z.string(),
  track: z.string(),
  status: PracticeStatus,
  solved: z.boolean(),
  anchorLessonId: z.string().nullable(),
});
export type PracticeListItem = z.infer<typeof PracticeListItem>;

export const PracticeListResponse = z.array(PracticeListItem);
export type PracticeListResponse = z.infer<typeof PracticeListResponse>;

/** `201` of `POST /api/practices/:id/runs`; `run_exists` carries the active `runId` in the error. */
export const CreateRunResponse = z.object({
  runId: z.uuid(),
  state: RunState,
  queuePosition: z.number().int().positive().nullable().optional(),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

/**
 * `GET /api/runs/:runId`. Beyond §5.1: `runId`, `practiceId`, `stopReason`, `usage` (the CPU / RAM
 * line of the practice screen), `resetsLeft` (of 3 per run).
 */
export const RunDto = z.object({
  runId: z.uuid(),
  practiceId: z.string(),
  state: RunState,
  stopReason: z.string().nullable(),
  queuePosition: z.number().int().positive().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  hardDeadline: z.iso.datetime().nullable(),
  goals: z.array(z.object({ id: z.string(), passed: z.boolean() })),
  hintsRevealed: Count,
  /** Texts of the revealed hints, in order. */
  hints: z.array(z.string()),
  canExtend: z.boolean(),
  resetsLeft: Count,
  usage: SandboxUsageDto.nullable(),
});
export type RunDto = z.infer<typeof RunDto>;

/** `POST /api/runs/:runId/terminal-ticket`: single-use, lives 30 s. */
export const TerminalTicketResponse = z.object({ ticket: z.string(), url: z.string() });
export type TerminalTicketResponse = z.infer<typeof TerminalTicketResponse>;

/** Reward summary of a solved practice (same base fields as the lesson / review summaries). */
export const PracticeSummaryDto = LessonSummaryDto.omit({
  kind: true,
  lessonId: true,
  mistakes: true,
  perfect: true,
}).extend({ kind: z.literal('practice'), practiceId: z.string() });
export type PracticeSummaryDto = z.infer<typeof PracticeSummaryDto>;

/** `POST /api/runs/:runId/check` (at most once per 5 s). */
export const CheckResponse = z.object({
  goals: z.array(z.object({ id: z.string(), passed: z.boolean(), output: z.string() })),
  solved: z.boolean(),
  xpAwarded: Count,
  /** With the first `solved: true` of the run. */
  summary: PracticeSummaryDto.optional(),
});
export type CheckResponse = z.infer<typeof CheckResponse>;

/** `POST /api/runs/:runId/hints`: reveals the next hint. */
export const HintResponse = z.object({ index: Count, text: z.string(), hintsRevealed: Count });
export type HintResponse = z.infer<typeof HintResponse>;

/** `POST /api/runs/:runId/extend`; `extend_not_allowed` otherwise. */
export const ExtendRunResponse = z.object({ expiresAt: z.iso.datetime() });
export type ExtendRunResponse = z.infer<typeof ExtendRunResponse>;

/** `POST /api/runs/:runId/reset` (≤ 3 per run, `reset_limit` otherwise). */
export const ResetRunResponse = z.object({ state: z.literal('starting') });
export type ResetRunResponse = z.infer<typeof ResetRunResponse>;
