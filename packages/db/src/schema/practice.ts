// Practice tables (spec §4.4, M4a). Same conventions as accounts.ts / learning.ts: snake_case
// columns, TypeScript-level enums on `text`, extend-only migrations. `sandboxes` is written only
// by `sandboxd`; `api` reads it and owns the other three tables.
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
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

export const PRACTICE_RUN_STATUSES = [
  'queued',
  'starting',
  'ready',
  'solved',
  'expired',
  'stopped',
  'failed',
  'queue_timeout',
] as const;
/** `queue_timeout` is `stopped` + `stop_reason = 'queue_timeout'` (no state of its own). */
export const SANDBOX_STATES = [
  'queued',
  'starting',
  'ready',
  'stopping',
  'stopped',
  'failed',
] as const;
/** States that count as the user's one active sandbox (partial unique index below). */
export const SANDBOX_ACTIVE_STATES = ['queued', 'starting', 'ready'] as const;
export const SANDBOX_CLASSES = ['light', 'docker', 'heavy'] as const;

/** Progress on a practice across runs: hints stay open, passed goals are remembered. */
export const practiceProgress = pgTable(
  'practice_progress',
  {
    userId: userRef(),
    practiceId: text('practice_id').notNull(),
    hintsRevealed: integer('hints_revealed').notNull().default(0),
    /** Goal ids passed at least once (a solve still needs every check in one pass). */
    goalsPassed: jsonb('goals_passed').$type<string[]>().notNull().default([]),
    firstSolvedAt: tstz('first_solved_at'),
    solveCount: integer('solve_count').notNull().default(0),
    xpAwarded: integer('xp_awarded').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.practiceId] })],
);

/** One attempt at a practice. A reset recreates the sandbox under the same run. */
export const practiceRuns = pgTable('practice_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userRef(),
  practiceId: text('practice_id').notNull(),
  contentVersion: text('content_version').notNull(),
  status: text('status', { enum: PRACTICE_RUN_STATUSES }).notNull().default('queued'),
  /** Resets used (≤ 3 per run, spec §5.1); an addition to §4.4. */
  resets: integer('resets').notNull().default(0),
  /**
   * The run's current sandbox (`sandboxes.id`, no foreign key: sandboxd owns that table); a reset
   * replaces it. Null until `sandboxd` accepted the create. An addition to §4.4 (0005).
   */
  sandboxId: uuid('sandbox_id'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  endedAt: tstz('ended_at'),
});

/**
 * Sandbox state, written only by `sandboxd`. Beyond §4.4: `user_id` is nullable (`test`
 * sandboxes of `practice:test` have no user), `title` (MOTD), `test`, `failure_output` (first
 * 2000 chars of a failed setup), and the creation spec (`hostname`, `setup_script`,
 * `setup_timeout_sec`, `ttl_min`) so a queued row can be started after a `sandboxd` restart.
 * `run_id` has no foreign key: test sandboxes carry a run id that is not in `practice_runs`.
 */
export const sandboxes = pgTable(
  'sandboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    containerId: text('container_id'),
    image: text('image').notNull(),
    class: text('class', { enum: SANDBOX_CLASSES }).notNull(),
    cpu: numeric('cpu', { precision: 4, scale: 2, mode: 'number' }).notNull(),
    memMb: integer('mem_mb').notNull(),
    state: text('state', { enum: SANDBOX_STATES }).notNull().default('queued'),
    title: text('title').notNull().default(''),
    test: boolean('test').notNull().default(false),
    hostname: text('hostname').notNull(),
    setupScript: text('setup_script').notNull(),
    setupTimeoutSec: integer('setup_timeout_sec').notNull(),
    ttlMin: integer('ttl_min').notNull(),
    queuedAt: tstz('queued_at').notNull().defaultNow(),
    readyAt: tstz('ready_at'),
    expiresAt: tstz('expires_at'),
    hardDeadline: tstz('hard_deadline'),
    lastActivityAt: tstz('last_activity_at'),
    stopReason: text('stop_reason'),
    failureOutput: text('failure_output'),
  },
  (t) => [
    uniqueIndex('sandboxes_one_active_per_user_idx')
      .on(t.userId)
      .where(sql`${t.state} IN ('queued', 'starting', 'ready')`),
    index('sandboxes_state_idx').on(t.state),
  ],
);

/** Sandbox minutes per user per day (in the user's zone); quota 180/day. */
export const sandboxUsage = pgTable(
  'sandbox_usage',
  {
    userId: userRef(),
    day: date('day', { mode: 'string' }).notNull(),
    minutes: integer('minutes').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);
