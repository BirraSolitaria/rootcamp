// Learning tables (spec §4.4, M3). Same conventions as accounts.ts: snake_case columns,
// TypeScript-level enums on `text`, extend-only migrations.
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts.js';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const userRef = () =>
  uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

export const LEARNING_SESSION_KINDS = ['lesson', 'review', 'drill'] as const;
/**
 * `in_progress` → `completed` | `out_of_hearts` | `abandoned` (replaced by a new start or
 * closed by the user) | `content_changed` (the active content version moved on).
 */
export const LEARNING_SESSION_STATUSES = [
  'in_progress',
  'completed',
  'out_of_hearts',
  'abandoned',
  'content_changed',
] as const;

/** One row per (user, lesson) the user has completed at least once → `completedLessonIds`. */
export const lessonCompletions = pgTable(
  'lesson_completions',
  {
    userId: userRef(),
    lessonId: text('lesson_id').notNull(),
    firstCompletedAt: tstz('first_completed_at').notNull().defaultNow(),
    times: integer('times').notNull().default(1),
    bestMistakes: integer('best_mistakes').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.lessonId] })],
);

/** Leitner boxes (`@rootcamp/logic` leitner.ts); `due_date` is a date key in the user's zone. */
export const reviewItems = pgTable(
  'review_items',
  {
    userId: userRef(),
    taskId: text('task_id').notNull(),
    box: integer('box').notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.taskId] }),
    index('review_items_user_id_due_date_idx').on(t.userId, t.dueDate),
    check('review_items_box_range', sql`${t.box} BETWEEN 1 AND 3`),
  ],
);

/** The active lesson / review / drill. At most one `in_progress` row per user. */
export const learningSessions = pgTable(
  'learning_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userRef(),
    kind: text('kind', { enum: LEARNING_SESSION_KINDS }).notNull(),
    lessonId: text('lesson_id'),
    contentVersion: text('content_version').notNull(),
    /** Serialised `LessonSession` / `ReviewSession` plus the last answer (Task 5). */
    state: jsonb('state').$type<unknown>().notNull(),
    status: text('status', { enum: LEARNING_SESSION_STATUSES }).notNull().default('in_progress'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('learning_sessions_one_in_progress_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'in_progress'`),
  ],
);
