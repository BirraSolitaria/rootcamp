// Practice catalogue for one user (spec §5.1 «Практика», `GET /api/practices`) and the practice
// part of `GET /api/progress`. A practice is `available` once the lesson right before its node
// is completed (`practiceAvailability`), `solved` once `practice_progress.first_solved_at` is set.
import type { PracticeListItem, PracticeStatus } from '@rootcamp/api-contract';
import type { Track } from '@rootcamp/content-schema';
import { practiceProgress } from '@rootcamp/db';
import { practiceAvailability } from '@rootcamp/logic';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { ContentStore } from './contentStore.js';
import type { Executor } from './executor.js';
import { completedLessonIds } from './progress.js';

/** Practice ids the user has solved at least once (in any content version). */
export async function solvedPracticeIds(db: Executor, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ practiceId: practiceProgress.practiceId })
    .from(practiceProgress)
    .where(and(eq(practiceProgress.userId, userId), isNotNull(practiceProgress.firstSolvedAt)));
  return new Set(rows.map((r) => r.practiceId));
}

/** `locked`/`available` from the path, `solved` over either once solved. */
export function practiceStatusesOf(
  tracks: Track[],
  done: Set<string>,
  solved: Set<string>,
): Record<string, PracticeStatus> {
  const result: Record<string, PracticeStatus> = {};
  for (const track of tracks) {
    for (const [id, status] of Object.entries(practiceAvailability(track, done))) {
      result[id] = solved.has(id) ? 'solved' : status;
    }
  }
  return result;
}

/** The track holding practice node `practiceId` and the lesson right before it (or null). */
export function locatePractice(
  store: ContentStore,
  practiceId: string,
): { track: Track; anchorLessonId: string | null } | undefined {
  for (const track of store.catalog.tracks) {
    let prev: string | null = null;
    for (const section of track.sections) {
      for (const node of section.nodes) {
        if (node.kind === 'lesson') prev = node.lessonId;
        else if (node.practiceId === practiceId) return { track, anchorLessonId: prev };
      }
    }
  }
  return undefined;
}

/**
 * `GET /api/practices`: every practice node of the active content whose server part exists, in
 * path order. `anchorLessonId` is the lesson that unlocks it (the one right before it; null when
 * the practice opens its track).
 */
export async function listPractices(
  db: Executor,
  store: ContentStore,
  userId: string,
): Promise<PracticeListItem[]> {
  const done = new Set(await completedLessonIds(db, store, userId));
  const solved = await solvedPracticeIds(db, userId);
  const statuses = practiceStatusesOf(store.catalog.tracks, done, solved);
  const items: PracticeListItem[] = [];
  for (const track of store.catalog.tracks) {
    let prev: string | null = null;
    for (const section of track.sections) {
      for (const node of section.nodes) {
        if (node.kind === 'lesson') {
          prev = node.lessonId;
          continue;
        }
        const practice = store.practice(node.practiceId);
        if (!practice) continue;
        items.push({
          id: node.practiceId,
          title: practice.manifest.title,
          track: track.id,
          status: statuses[node.practiceId] ?? 'locked',
          solved: solved.has(node.practiceId),
          anchorLessonId: prev,
        });
      }
    }
  }
  return items;
}
