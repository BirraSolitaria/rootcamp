import type { Lesson, Section, Task, Track } from '@rootcamp/content-schema';

/** Loaded course content: track catalog plus the sections fetched so far, by id. */
export interface CourseIndex {
  tracks: Track[];
  sections: ReadonlyMap<string, Section>;
}

export function findLesson(ix: CourseIndex, id: string): Lesson | undefined {
  for (const section of ix.sections.values()) {
    const lesson = section.lessons.find((l) => l.id === id);
    if (lesson) return lesson;
  }
  return undefined;
}

export function findTask(ix: CourseIndex, id: string): Task | undefined {
  for (const section of ix.sections.values()) {
    for (const lesson of section.lessons) {
      const task = lesson.tasks.find((t) => t.id === id);
      if (task) return task;
    }
  }
  return undefined;
}

export function allTaskIds(ix: CourseIndex): Set<string> {
  const ids = new Set<string>();
  for (const section of ix.sections.values()) {
    for (const lesson of section.lessons) {
      for (const task of lesson.tasks) ids.add(task.id);
    }
  }
  return ids;
}

/**
 * Tasks of the given lessons in the given order, without terminal_practice
 * tasks; unknown lesson ids are ignored.
 */
export function tasksOfLessons(ix: CourseIndex, ids: string[]): Task[] {
  return ids.flatMap((id) => findLesson(ix, id)?.tasks ?? []).filter((t) => t.type !== 'terminal_practice');
}

/** Ids of `kind: 'lesson'` nodes of the track, in path order. */
export function trackLessonIds(track: Track): string[] {
  return track.sections.flatMap((s) => s.nodes.flatMap((n) => (n.kind === 'lesson' ? [n.lessonId] : [])));
}
