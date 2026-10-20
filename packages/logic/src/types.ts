/** Calendar day "YYYY-MM-DD" in the user's IANA time zone (see `toDateKey`). */
export type DateKey = string;

type TaskId = string;
type LessonId = string;

export interface Hearts {
  count: number;
  lastRegenAt: number;
}
export interface Streak {
  current: number;
  best: number;
  lastActivityDate: DateKey | null;
}
export interface LeitnerItem {
  taskId: TaskId;
  box: 1 | 2 | 3;
  dueDate: DateKey;
}
export type ReviewItems = Record<TaskId, LeitnerItem>;

interface SummaryBase {
  xpGained: number;
  xpToday: number;
  dailyGoal: number;
  goalJustReached: boolean;
  streak: number;
  streakIncreased: boolean;
}
export interface LessonSummary extends SummaryBase {
  kind: 'lesson';
  lessonId: LessonId;
  mistakes: number;
  perfect: boolean;
}
export interface ReviewSummary extends SummaryBase {
  kind: 'review';
  mode: 'review' | 'drill';
  correct: number;
  total: number;
  heartGained: boolean;
}
