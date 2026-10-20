import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations } from '@rootcamp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, POSTGRES_IMAGE, postgresUrl } from './harness.js';

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe('runMigrations', () => {
  it('two concurrent runs on one database both succeed and seed default settings', async () => {
    const a = createDb(postgresUrl(container));
    const b = createDb(postgresUrl(container));
    try {
      await Promise.all([runMigrations(a.db, MIGRATIONS_DIR), runMigrations(b.db, MIGRATIONS_DIR)]);

      const rows = await a.sql<{ value: unknown }[]>`
        select value from settings where key = 'max_users'`;
      expect(rows.map((r) => r.value)).toEqual([50]);

      const mode = await a.sql<{ value: unknown }[]>`
        select value from settings where key = 'registration_mode'`;
      expect(mode.map((r) => r.value)).toEqual(['open']);

      // Each journal entry is applied exactly once; re-running on an up-to-date database is a no-op.
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
      ) as {
        entries: unknown[];
      };
      await runMigrations(a.db, MIGRATIONS_DIR);
      const applied = await a.sql`select id from drizzle.__drizzle_migrations`;
      expect(applied).toHaveLength(journal.entries.length);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 30_000);
});
