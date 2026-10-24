import type { PracticeStatus, ProgressDto } from '@rootcamp/api-contract';
import { lessonCompletions, reviewItems, users, type Db } from '@rootcamp/db';
import {
  dueTaskIdsInCourse,
  toDateKey,
  trackLessonIds,
  type LeitnerItem,
  type ReviewItems,
} from '@rootcamp/logic';
import { and, eq, lte } from 'drizzle-orm';
import { HttpError } from '../plugins/errors.js';
import type { ContentStore } from './contentStore.js';
import type { Executor } from './executor.js';
import { practiceStatusesOf, solvedPracticeIds } from './practices.js';

/**
 * Lessons the user has completed that exist in `store`: completions of removed lessons stay
 * in the DB but are ignored (spec §4.1).
 */
export async function completedLessonIds(
  db: Executor,
  store: ContentStore,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ lessonId: lessonCompletions.lessonId })
    .from(lessonCompletions)
    .where(eq(lessonCompletions.userId, userId));
  return rows.map((r) => r.lessonId).filter((id) => store.lesson(id) !== undefined);
}

/**
 * `GET /api/progress` (spec §5.1) against the active content. `dueCount` counts review items
 * due by today in the user's zone whose tasks exist and are not `terminal_practice`.
 * `practiceStatuses`: `locked`/`available` from the path, `solved` once solved (practices.ts).
 */
export async function getProgress(
  db: Db,
  store: ContentStore,
  userId: string,
  now: number,
): Promise<ProgressDto> {
  const [user] = await db.select({ tz: users.tz }).from(users).where(eq(users.id, userId));
  if (!user) throw new HttpError(401, 'unauthorized', 'sign in required');
  const today = toDateKey(now, user.tz);

  const completed = await completedLessonIds(db, store, userId);
  const done = new Set(completed);

  const due = await db
    .select()
    .from(reviewItems)
    .where(and(eq(reviewItems.userId, userId), lte(reviewItems.dueDate, today)));
  const items: ReviewItems = {};
  for (const r of due) {
    items[r.taskId] = { taskId: r.taskId, box: r.box as LeitnerItem['box'], dueDate: r.dueDate };
  }

  const practiceStatuses: Record<string, PracticeStatus> = practiceStatusesOf(
    store.catalog.tracks,
    done,
    await solvedPracticeIds(db, userId),
  );
  const tracks = store.catalog.tracks.map((track) => {
    const lessonIds = trackLessonIds(track);
    const completedLessons = lessonIds.filter((id) => done.has(id)).length;
    return {
      id: track.id,
      completedLessons,
      totalLessons: lessonIds.length,
      done: track.status === 'complete' && completedLessons === lessonIds.length,
    };
  });

  return {
    completedLessonIds: completed,
    practiceStatuses,
    dueCount: dueTaskIdsInCourse(items, store.index, today).length,
    tracks,
  };
}
