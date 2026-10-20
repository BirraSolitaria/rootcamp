/**
 * Default `settings` rows. Migration 0000 inserts the same values; the test harness
 * re-seeds them after TRUNCATE.
 */
export const DEFAULT_SETTINGS = {
  registration_mode: 'open',
  max_users: 50,
} as const satisfies Record<string, unknown>;
