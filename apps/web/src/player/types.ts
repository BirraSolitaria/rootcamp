import type { Task, UserAnswer } from '@rootcamp/content-schema';

export interface TaskViewProps<T extends Task> {
  task: T;
  /** After «Проверить»: the answer can no longer change. */
  locked: boolean;
  /** Seeded per presentation; used once, on mount. */
  rng: () => number;
  /** `null` — the answer is not formed yet. */
  onChange(answer: UserAnswer | null): void;
}

/** Heading of the task; the player focuses it when a task is shown. */
export const HEADING_ATTR = { 'data-task-heading': '' } as const;
