import type { Track } from '@rootcamp/content-schema';
import { trackLessonIds } from './courseQuery.js';

export type LessonStatus = 'completed' | 'current' | 'locked';

/**
 * Linear order over the track's `kind: 'lesson'` nodes: completed if in the
 * list, the first non-completed is current, the rest are locked. Practices
 * never block lessons.
 */
export function lessonStatuses(track: Track, completed: Iterable<string>): Record<string, LessonStatus> {
  const done = new Set(completed);
  const result: Record<string, LessonStatus> = {};
  let currentAssigned = false;
  for (const id of trackLessonIds(track)) {
    if (done.has(id)) {
      result[id] = 'completed';
    } else if (!currentAssigned) {
      result[id] = 'current';
      currentAssigned = true;
    } else {
      result[id] = 'locked';
    }
  }
  return result;
}

export function currentLessonId(track: Track, completed: Iterable<string>): string | null {
  const done = new Set(completed);
  return trackLessonIds(track).find((id) => !done.has(id)) ?? null;
}

/** All `kind: 'lesson'` nodes are completed (practices do not count). */
export function isTrackComplete(track: Track, completed: Iterable<string>): boolean {
  return currentLessonId(track, completed) === null;
}

/**
 * A practice is available once the nearest preceding `kind: 'lesson'` node in
 * the track path (across sections) is completed; with no such node it is
 * available from the start. Keyed by practiceId.
 */
export function practiceAvailability(
  track: Track,
  completed: Iterable<string>,
): Record<string, 'locked' | 'available'> {
  const done = new Set(completed);
  const result: Record<string, 'locked' | 'available'> = {};
  let prevLessonId: string | null = null;
  for (const section of track.sections) {
    for (const node of section.nodes) {
      if (node.kind === 'lesson') {
        prevLessonId = node.lessonId;
      } else {
        result[node.practiceId] = prevLessonId === null || done.has(prevLessonId) ? 'available' : 'locked';
      }
    }
  }
  return result;
}
