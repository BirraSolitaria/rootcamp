import { z } from 'zod';

const Count = z.number().int().nonnegative();

/** Same shape as `UserAnswer` in `@rootcamp/content-schema` (terminal_practice has none). */
export const UserAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('single_choice'), selectedIndex: z.number().int() }),
  z.object({ type: z.literal('true_false'), value: z.boolean() }),
  z.object({ type: z.literal('assemble'), tokens: z.array(z.string()).max(100) }),
  z.object({ type: z.literal('fill_blank'), text: z.string().max(1000) }),
  z.object({
    type: z.literal('match_pairs'),
    pairs: z.array(z.object({ left: z.string(), right: z.string() })).max(100),
  }),
  z.object({ type: z.literal('order_steps'), order: z.array(z.string()).max(100) }),
]);
export type UserAnswer = z.infer<typeof UserAnswer>;

/** Hearts after regen; `msToNext` is null at the maximum. */
export const HeartsDto = z.object({ count: Count, msToNext: z.number().nonnegative().nullable() });
export type HeartsDto = z.infer<typeof HeartsDto>;

/** `POST /api/lessons/:lessonId/start`: the session shows `queue[0]` with `presentation`. */
export const StartLessonResponse = z.object({
  sessionId: z.uuid(),
  hearts: HeartsDto,
  queue: z.array(z.string()),
  /** Send it back with the answer to `queue[0]`. */
  presentation: z.number().int().positive(),
});
export type StartLessonResponse = z.infer<typeof StartLessonResponse>;

/**
 * `POST /api/sessions/:id/answer`. `presentation` (an addition to spec §5.1) makes a retried
 * request idempotent (§9): the same `taskId` + `presentation` returns the first response.
 */
export const AnswerBody = z.object({
  taskId: z.string().min(1).max(200),
  presentation: z.number().int().positive(),
  answer: UserAnswer,
});
export type AnswerBody = z.infer<typeof AnswerBody>;

const SummaryBase = {
  xpGained: Count,
  xpToday: Count,
  dailyGoal: Count,
  goalJustReached: z.boolean(),
  streak: Count,
  streakIncreased: z.boolean(),
};
/** `LessonSummary` of `@rootcamp/logic`. */
export const LessonSummaryDto = z.object({
  ...SummaryBase,
  kind: z.literal('lesson'),
  lessonId: z.string(),
  mistakes: Count,
  perfect: z.boolean(),
});
/** `ReviewSummary` of `@rootcamp/logic`. */
export const ReviewSummaryDto = z.object({
  ...SummaryBase,
  kind: z.literal('review'),
  mode: z.enum(['review', 'drill']),
  correct: Count,
  total: Count,
  heartGained: z.boolean(),
});
export const SummaryDto = z.discriminatedUnion('kind', [LessonSummaryDto, ReviewSummaryDto]);
export type SummaryDto = z.infer<typeof SummaryDto>;

export const SessionStatus = z.enum(['in_progress', 'out_of_hearts', 'completed']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const AnswerResponse = z.object({
  correct: z.boolean(),
  correctAnswerText: z.string(),
  hearts: HeartsDto,
  status: SessionStatus,
  /** Task to show next; null once the session is over. */
  nextTaskId: z.string().nullable(),
  /** Presentation of `nextTaskId`: send it with the next answer. */
  presentation: z.number().int().nonnegative(),
  /** With `status: 'completed'`. */
  summary: SummaryDto.optional(),
});
export type AnswerResponse = z.infer<typeof AnswerResponse>;
