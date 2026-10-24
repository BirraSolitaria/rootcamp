import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MIGRATION_LOCK_KEY } from '../src/index.js';
import * as schema from '../src/schema/index.js';

describe('@rootcamp/db schema', () => {
  it('exports the M2 accounts tables under their SQL names', () => {
    const names = [
      schema.users,
      schema.sessions,
      schema.emailTokens,
      schema.emailLog,
      schema.hearts,
      schema.streaks,
      schema.xpEvents,
      schema.settings,
      schema.auditLog,
    ].map(getTableName);
    expect(names).toEqual([
      'users',
      'sessions',
      'email_tokens',
      'email_log',
      'hearts',
      'streaks',
      'xp_events',
      'settings',
      'audit_log',
    ]);
  });

  it('exports the M3 learning tables under their SQL names', () => {
    expect(
      [schema.lessonCompletions, schema.reviewItems, schema.learningSessions].map(getTableName),
    ).toEqual(['lesson_completions', 'review_items', 'learning_sessions']);
  });

  it('exports the M4a practice tables under their SQL names', () => {
    expect(
      [schema.practiceProgress, schema.practiceRuns, schema.sandboxes, schema.sandboxUsage].map(
        getTableName,
      ),
    ).toEqual(['practice_progress', 'practice_runs', 'sandboxes', 'sandbox_usage']);
  });

  it('default settings are registration open and 50 users', () => {
    expect(DEFAULT_SETTINGS).toEqual({ registration_mode: 'open', max_users: 50 });
  });

  it('uses the agreed advisory lock key', () => {
    expect(MIGRATION_LOCK_KEY).toBe(727001);
  });
});
