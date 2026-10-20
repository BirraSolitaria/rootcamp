import { settings } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import type { Executor } from './executor.js';

export type RegistrationMode = 'open' | 'closed';

/** Value of a `settings` row, or `fallback` when the row is missing. */
export async function getSetting<T>(db: Executor, key: string, fallback: T): Promise<T> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  return row ? (row.value as T) : fallback;
}

/** Inserts or replaces a `settings` row. */
export async function setSetting(db: Executor, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

/**
 * Reads `registration_mode` with `FOR UPDATE`. Inside a transaction this serialises concurrent
 * registrations, so two requests cannot both pass the `max_users` check.
 */
export async function lockRegistrationMode(tx: Executor): Promise<RegistrationMode> {
  const [row] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'registration_mode'))
    .for('update');
  return row?.value === 'closed' ? 'closed' : 'open';
}
