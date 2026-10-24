// Shared harness for the Docker-backed suites (gc, reconcile): real PostgreSQL 16
// (Testcontainers) and a runc-dev driver scoped to this suite's own sandboxes. Runs where
// Docker is reachable (the VPS, R-M4a-1).
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, sandboxes, users, type Db, type DbHandle } from '@rootcamp/db';
import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { RuncDevDriver } from '../../src/driver/runc-dev.js';
import { SANDBOX_LABEL, type ManagedContainer } from '../../src/driver/types.js';

export const docker = new Docker();
export const dockerAvailable = await docker.ping().then(
  () => true,
  () => false,
);

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../api/drizzle', import.meta.url));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Pg {
  pg: StartedPostgreSqlContainer;
  h: DbHandle;
}

export async function startPg(): Promise<Pg> {
  const pg = await new PostgreSqlContainer('postgres:16')
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off'])
    .start();
  const host = pg.getHost() === 'localhost' ? '127.0.0.1' : pg.getHost();
  const url = `postgres://${pg.getUsername()}:${pg.getPassword()}@${host}:${pg.getPort()}/${pg.getDatabase()}`;
  const h = createDb(url);
  await runMigrations(h.db, MIGRATIONS_DIR);
  return { pg, h };
}

/**
 * The daemon is shared with the other suites (vitest runs files in parallel) and the live
 * stand, so this suite's GC / reconcile must only see its own containers: those of a row in
 * its own database, plus the ids it registers in `extra` (orphans it made on purpose).
 * `diskMb` overrides `diskUsageMb` per container id.
 */
export class ScopedDriver extends RuncDevDriver {
  readonly extra = new Set<string>();
  readonly diskMb = new Map<string, number>();

  constructor(private readonly db: Db) {
    super({ docker, network: 'rc-sbx-dev' });
  }

  override async listManaged(): Promise<ManagedContainer[]> {
    const all = await super.listManaged();
    const ids = new Set(
      (await this.db.select({ id: sandboxes.id }).from(sandboxes)).map((r) => r.id),
    );
    return all.filter((c) => ids.has(c.sandboxId) || this.extra.has(c.sandboxId));
  }

  override diskUsageMb(id: string): Promise<number> {
    const o = this.diskMb.get(id);
    return o === undefined ? super.diskUsageMb(id) : Promise.resolve(o);
  }
}

export async function newUser(db: Db): Promise<string> {
  const nick = `u${randomUUID().slice(0, 8)}`;
  const [u] = await db
    .insert(users)
    .values({ email: `${nick}@rootcamp.test`, nick, passwordHash: 'x', tz: 'Europe/Moscow' })
    .returning({ id: users.id });
  return u!.id;
}

export const createBody = (over: Record<string, unknown> = {}) => ({
  runId: randomUUID(),
  userId: null as string | null,
  image: 'rc/linux-base:24.04',
  class: 'light' as const,
  hostname: 'web-01',
  title: 'GC test',
  setupScript: 'true',
  setupTimeoutSec: 30,
  ttlMin: 30,
  ...over,
});

/** Containers labelled `rootcamp.sandbox=<id>`. */
export async function containersOf(id: string) {
  return docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=${id}`] } });
}

/** Removes every labelled container whose sandbox id is in `ids`; nothing else is touched. */
export async function sweep(ids: Iterable<string>): Promise<void> {
  const want = new Set(ids);
  const list = await docker.listContainers({ all: true, filters: { label: [SANDBOX_LABEL] } });
  for (const c of list) {
    if (!want.has(c.Labels[SANDBOX_LABEL] ?? '')) continue;
    await docker
      .getContainer(c.Id)
      .remove({ force: true, v: true })
      .catch(() => {});
  }
}

/** Ids of every row in the suite's database (for the final sweep). */
export async function allRowIds(db: Db): Promise<string[]> {
  return (await db.select({ id: sandboxes.id }).from(sandboxes)).map((r) => r.id);
}

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
