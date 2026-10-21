import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContentVersionDto } from '@rootcamp/api-contract';
import { auditLog, settings, users } from '@rootcamp/db';
import type { ContentTree } from '@rootcamp/content-schema/node';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { startContentHolder } from '../src/services/contentStore.js';
import { buildCourse, tempContentDir } from './course.js';
import { TEST_PUBLIC_ORIGIN, useHarness } from './harness.js';

const contentDir = tempContentDir();
const h = useHarness({ contentDir });
const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };

let v1: string;
let v2: string;
beforeAll(async () => {
  v1 = await buildCourse(contentDir);
  // Same course with another t7 title → another version.
  v2 = await buildCourse(contentDir, undefined, (tree: ContentTree) => {
    const t7 = tree.tracks.find((t) => t.src.id === 't7')!;
    t7.src.title = `${t7.src.title} v2`;
  });
}, 60_000);

afterAll(async () => {
  await rm(contentDir, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

async function cli(...argv: string[]) {
  const c = capture();
  const code = await runCli(argv, { db: h().db, contentDir, ...c.io });
  return { code, out: c.out.join('\n'), err: c.err.join('\n') };
}

/** Registers a verified user; returns the session cookie. */
async function signIn(): Promise<Record<string, string>> {
  const res = await h().app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: csrf,
    payload: { email: 'ann@mail.ru', nick: 'ann', password: 'correct horse battery', tz: 'UTC' },
  });
  expect(res.statusCode).toBe(201);
  const { user } = res.json() as { user: { id: string } };
  await h().db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  return { rc_sid: res.cookies.find((c) => c.name === 'rc_sid')!.value };
}

function getVersion(cookies: Record<string, string>) {
  return h().app.inject({ method: 'GET', url: '/api/content/version', cookies });
}

/** Polls until the api reports `version` (NOTIFY is asynchronous). */
async function waitForVersion(cookies: Record<string, string>, version: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const res = await getVersion(cookies);
    if (res.statusCode === 200 && (res.json() as { version: string }).version === version) {
      return res;
    }
    if (Date.now() > deadline) throw new Error(`api still reports ${res.body}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('content activation', () => {
  it('without an active version content routes answer 503', async () => {
    const cookies = await signIn();
    const res = await getVersion(cookies);
    expect(res.statusCode).toBe(503);
  });

  it('requires a session', async () => {
    expect((await getVersion({})).statusCode).toBe(401);
  });

  it('activate → version and baseUrl; a second activate is picked up without a restart', async () => {
    const cookies = await signIn();
    const first = await cli('content:activate', v1);
    expect(first).toMatchObject({ code: 0, out: `activated ${v1}` });
    const res = await waitForVersion(cookies, v1);
    expect(ContentVersionDto.parse(res.json())).toEqual({
      version: v1,
      baseUrl: `/content/${v1}/`,
    });

    expect((await cli('content:activate', v2)).code).toBe(0);
    await waitForVersion(cookies, v2);

    const [row] = await h().db.select().from(settings).where(eq(settings.key, 'content_version'));
    expect(row?.value).toBe(v2);
    const audit = await h()
      .db.select()
      .from(auditLog)
      .where(eq(auditLog.action, 'content.activate'));
    expect(audit.map((a) => a.targetId)).toEqual([v1, v2]);
  });

  it('a holder started later loads the stored version; NOTIFY reaches every holder', async () => {
    // Stored without NOTIFY: only a start-time read can see it.
    await h().db.insert(settings).values({ key: 'content_version', value: v1 });
    const holder = await startContentHolder({ db: h().db, dir: contentDir });
    try {
      expect(holder.current().version).toBe(v1);
      expect(holder.current().lesson('t7.s01.l01')?.id).toBe('t7.s01.l01');
      expect((await cli('content:activate', v2)).code).toBe(0);
      const deadline = Date.now() + 5_000;
      while (holder.peek()?.version !== v2) {
        if (Date.now() > deadline) throw new Error('holder did not reload');
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await holder.close();
    }
  });

  it('refuses a version that is not installed or malformed', async () => {
    const missing = await cli('content:activate', 'abcdef012345');
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/abcdef012345/);
    const bad = await cli('content:activate', '../etc');
    expect(bad.code).toBe(1);
    expect(await h().db.select().from(settings).where(eq(settings.key, 'content_version'))).toEqual(
      [],
    );
  });

  it('content:list shows installed versions and marks the active one', async () => {
    expect((await cli('content:activate', v2)).code).toBe(0);
    const res = await cli('content:list');
    expect(res.code).toBe(0);
    const lines = res.out.split('\n');
    expect(lines).toContain(`${v1}`);
    expect(lines).toContain(`${v2} (active)`);
  });
});

describe('content:install', () => {
  it('copies new versions from a content-dist and keeps existing ones', async () => {
    const target = tempContentDir();
    try {
      // A stale marker in an "installed" version must survive (same hash = same content).
      await mkdir(join(target, 'server', v1), { recursive: true });
      await writeFile(join(target, 'server', v1, 'marker'), 'x');
      const c = capture();
      const code = await runCli(['content:install', contentDir], {
        db: h().db,
        contentDir: target,
        ...c.io,
      });
      expect(code).toBe(0);
      expect(c.out).toContain(`installed ${v2}`);
      expect((await readdir(join(target, 'server'))).sort()).toEqual([v1, v2].sort());
      expect((await readdir(join(target, 'public'))).sort()).toEqual([v1, v2].sort());
      expect(await readdir(join(target, 'server', v1))).toEqual(['marker']);
      expect((await readdir(target)).sort()).toEqual(['public', 'server']);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
