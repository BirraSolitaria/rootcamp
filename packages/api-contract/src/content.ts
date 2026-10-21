import { z } from 'zod';

const Count = z.number().int().nonnegative();

/** `GET /api/content/version`: the active content hash and where its public files live. */
export const ContentVersionDto = z.object({
  version: z.string().regex(/^[0-9a-f]{12}$/),
  /** `/content/<version>/` — catalog.json, sections/<id>.json, practices/<id>.json. */
  baseUrl: z.string(),
});
export type ContentVersionDto = z.infer<typeof ContentVersionDto>;

export const PracticeStatus = z.enum(['locked', 'available', 'solved']);
export type PracticeStatus = z.infer<typeof PracticeStatus>;

export const TrackProgressDto = z.object({
  id: z.string(),
  /** Completed `kind: lesson` nodes of the track (practices are not counted). */
  completedLessons: Count,
  totalLessons: Count,
  /** `status: complete` and every lesson completed (spec §4.5). */
  done: z.boolean(),
});
export type TrackProgressDto = z.infer<typeof TrackProgressDto>;

/** `GET /api/progress` (spec §5.1), against the active content version. */
export const ProgressDto = z.object({
  /** Completed lessons that exist in the active version. */
  completedLessonIds: z.array(z.string()),
  practiceStatuses: z.record(z.string(), PracticeStatus),
  /** Review items due today (user's zone) whose tasks exist in the active version. */
  dueCount: Count,
  tracks: z.array(TrackProgressDto),
});
export type ProgressDto = z.infer<typeof ProgressDto>;
