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

  it('0004 creates the practice tables with the sandbox indexes and extra columns', async () => {
    const h = createDb(postgresUrl(container));
    try {
      await runMigrations(h.db, MIGRATIONS_DIR);
      const tables = await h.sql<{ tablename: string }[]>`
        select tablename from pg_tables
        where schemaname = 'public'
          and tablename in ('practice_progress', 'practice_runs', 'sandboxes', 'sandbox_usage')
        order by tablename`;
      expect(tables.map((t) => t.tablename)).toEqual([
        'practice_progress',
        'practice_runs',
        'sandbox_usage',
        'sandboxes',
      ]);

      const indexes = await h.sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'sandboxes' order by indexname`;
      const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
      expect(byName.get('sandboxes_state_idx')).toMatch(/\(state\)/);
      const active = byName.get('sandboxes_one_active_per_user_idx') ?? '';
      expect(active).toMatch(/^CREATE UNIQUE INDEX/);
      expect(active).toMatch(/\(user_id\) WHERE/);
      expect(active).toMatch(/'queued'.*'starting'.*'ready'/);

      const cols = await h.sql<
        { column_name: string; is_nullable: string; column_default: string | null }[]
      >`
        select column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'sandboxes'`;
      const col = new Map(cols.map((c) => [c.column_name, c]));
      expect(col.get('user_id')?.is_nullable).toBe('YES');
      expect(col.get('title')).toBeDefined();
      expect(col.get('test')?.column_default).toBe('false');
      expect(col.get('failure_output')?.is_nullable).toBe('YES');

      // At most one queued…ready sandbox per user; finished ones and user-less test ones don't count.
      const [user] = await h.sql<{ id: string }[]>`
        insert into users (email, nick, password_hash)
        values ('mig@example.com', 'mig_user', 'x') returning id`;
      const insert = (userId: string | null, state: string) => h.sql`
        insert into sandboxes
          (run_id, user_id, image, class, cpu, mem_mb, state, hostname, setup_script,
           setup_timeout_sec, ttl_min)
        values (gen_random_uuid(), ${userId}, 'rc/test-shell', 'light', 0.5, 512, ${state},
                'web-01', 'true', 60, 30)`;
      await insert(user!.id, 'stopped');
      await insert(user!.id, 'failed');
      await insert(user!.id, 'queued');
      await expect(insert(user!.id, 'ready')).rejects.toThrow(/sandboxes_one_active_per_user_idx/);
      await insert(null, 'ready');
      await insert(null, 'ready');
    } finally {
      await h.close();
    }
  }, 30_000);
});
