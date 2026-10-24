import { z } from 'zod';
import { TaskSchema, TheoryCardSchema } from './types.js';

// YAML source schemas (spec §4.2). As in types.ts, zod checks shape only;
// ID formats, lengths and cross-references are left to the validator.
// The practice manifest ranges below are fixed by the plan for this schema.

/** content/tracks/<t>/track.yaml */
export const TrackSrcSchema = z.strictObject({
  id: z.string(),
  order: z.number().int(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['draft', 'partial', 'complete']),
  prerequisites: z.array(z.string()).default([]),
  reviewedAt: z.string(),
  sections: z.array(z.string()),
});
export type TrackSrc = z.infer<typeof TrackSrcSchema>;

export const SectionNodeSrcSchema = z.union([
  z.strictObject({ lesson: z.string() }),
  z.strictObject({ practice: z.string() }),
]);
export type SectionNodeSrc = z.infer<typeof SectionNodeSrcSchema>;

/** content/tracks/<t>/<s>/section.yaml */
export const SectionSrcSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  nodes: z.array(SectionNodeSrcSchema),
});
export type SectionSrc = z.infer<typeof SectionSrcSchema>;

/** content/tracks/<t>/<s>/<l>.yaml */
export const LessonSrcSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  theory: TheoryCardSchema,
  tasks: z.array(TaskSchema),
});
export type LessonSrc = z.infer<typeof LessonSrcSchema>;

export const ImageClassSchema = z.enum(['light', 'docker', 'heavy']);
export type ImageClass = z.infer<typeof ImageClassSchema>;

export const PracticeGoalSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  check: z.string(),
  timeoutSec: z.number().int().min(1).max(30).default(10),
});
export type PracticeGoal = z.infer<typeof PracticeGoalSchema>;

/** content/practices/<id>/practice.yaml */
export const PracticeManifestSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  track: z.string(),
  brief: z.string(),
  image: z.string(),
  class: ImageClassSchema,
  hostname: z.string(),
  timeoutMin: z.number().int().min(15).max(60),
  setupTimeoutSec: z.number().int().positive(),
  goals: z.array(PracticeGoalSchema).min(1).max(5),
  hints: z.array(z.string()).min(1).max(4),
  reward: z.strictObject({
    base: z.number().int().nonnegative(),
    noHintBonus: z.number().int().nonnegative(),
    hintCost: z.number().int().nonnegative(),
  }),
  solution: z.string(),
  innerImages: z.array(z.string()).default([]),
});
export type PracticeManifest = z.infer<typeof PracticeManifestSchema>;

/** sandbox/images/registry.yaml */
export const ImageRegistrySchema = z.strictObject({
  images: z.array(
    z.strictObject({
      ref: z.string(),
      class: ImageClassSchema,
      cpu: z.number().positive(),
      memMb: z.number().int().positive(),
      pids: z.number().int().positive(),
    }),
  ),
});
export type ImageRegistry = z.infer<typeof ImageRegistrySchema>;

/**
 * `<extra root>/overlays/<sectionId>.yaml` (e2e fixtures only): put a practice node into a
 * section of the main content right after its node `insertAfter` (a lesson or practice name as
 * written in section.yaml, e.g. `l01`).
 */
export const SectionOverlaySchema = z.strictObject({
  insertAfter: z.string(),
  practice: z.string(),
});
export type SectionOverlay = z.infer<typeof SectionOverlaySchema>;

/** content/removed-ids.yaml */
export const RemovedIdsSchema = z.strictObject({ ids: z.array(z.string()) });

/** content/published-ids.json */
export const PublishedIdsSchema = z.array(z.string());
