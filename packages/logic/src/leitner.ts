import { addDays, diffDays } from './dates.js';
import type { DateKey, LeitnerItem, ReviewItems } from './types.js';

type TaskId = string;

/** Days until the next review for each box (§7.6). */
export const INTERVAL = { 1: 1, 2: 3, 3: 7 } as const;

export function markWrong(items: ReviewItems, taskId: TaskId, today: DateKey): ReviewItems {
  return { ...items, [taskId]: { taskId, box: 1, dueDate: addDays(today, INTERVAL[1]) } };
}

export function markCorrectInReview(
  items: ReviewItems,
  taskId: TaskId,
  today: DateKey,
): ReviewItems {
  const item = items[taskId];
  if (!item) return { ...items };
  const rest = { ...items };
  delete rest[taskId];
  if (item.box === 3) return rest;
  const box = (item.box + 1) as 2 | 3;
  return { ...rest, [taskId]: { taskId, box, dueDate: addDays(today, INTERVAL[box]) } };
}

/** Items due today or earlier, ordered by dueDate, then box, then taskId. */
export function dueItems(items: ReviewItems, today: DateKey): LeitnerItem[] {
  return Object.values(items)
    .filter((i) => diffDays(i.dueDate, today) >= 0)
    .sort((a, b) =>
      a.dueDate !== b.dueDate
        ? a.dueDate < b.dueDate
          ? -1
          : 1
        : a.box !== b.box
          ? a.box - b.box
          : a.taskId < b.taskId
            ? -1
            : a.taskId > b.taskId
              ? 1
              : 0,
    );
}
