import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client.js';

/** Session-level advisory lock key serialising migrations across api replicas. */
export const MIGRATION_LOCK_KEY = 727001;

/**
 * Applies the drizzle migrations in `dir` (the folder holding `meta/_journal.json`).
 * Concurrent callers are serialised by `pg_advisory_lock(727001)`: the lock is held on a
 * reserved pool connection while `migrate()` runs on the rest of the pool, so the pool
 * must allow at least 2 connections.
 */
export async function runMigrations(db: Db, dir: string): Promise<void> {
  const lock = await db.$client.reserve();
  try {
    await lock`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      await lock`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    lock.release();
  }
}
