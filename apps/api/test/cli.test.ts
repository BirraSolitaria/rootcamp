import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { auditLog, settings, users } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { useHarness } from './harness.js';

const h = useHarness();
const execFileP = promisify(execFile);
const API_DIR = fileURLToPath(new URL('..', import.meta.url));

const baseUser = {
  email: 'ann@x.ru',
  nick: 'ann',
  passwordHash: 'not-a-real-hash',
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out,
    err,
  };
}

describe('rootcamp-cli admin:grant', () => {
  it('sets is_admin and writes an audit_log row with actor_id = null', async () => {
    const { db } = h();
    const [ann] = await db.insert(users).values(baseUser).returning();
    const c = capture();

    const code = await runCli(['admin:grant', 'ann@x.ru'], { db, ...c.io });

    expect(code).toBe(0);
    expect(c.out.join('\n')).toMatch(/granted/);
    const [row] = await db.select().from(users).where(eq(users.id, ann!.id));
    expect(row!.isAdmin).toBe(true);
    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: null, action: 'admin.grant', targetId: ann!.id });
  });

  it('matches the email case-insensitively', async () => {
    const { db } = h();
    await db.insert(users).values(baseUser);
    const c = capture();
    expect(await runCli(['admin:grant', 'Ann@X.RU'], { db, ...c.io })).toBe(0);
    const [row] = await db.select().from(users);
    expect(row!.isAdmin).toBe(true);
  });

  it('unknown email: exit code 1, nothing changed', async () => {
    const { db } = h();
    await db.insert(users).values(baseUser);
    const c = capture();

    const code = await runCli(['admin:grant', 'nobody@x.ru'], { db, ...c.io });

    expect(code).toBe(1);
    expect(c.err.join('\n')).toMatch(/nobody@x\.ru/);
    const [row] = await db.select().from(users);
    expect(row!.isAdmin).toBe(false);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('unknown command or missing argument: non-zero exit', async () => {
    const { db } = h();
    const c = capture();
    expect(await runCli(['nope'], { db, ...c.io })).not.toBe(0);
    expect(await runCli(['admin:grant'], { db, ...c.io })).not.toBe(0);
  });

  it('as a process: reads DATABASE_URL, exits 0 on grant and 1 on an unknown email', async () => {
    const { db, databaseUrl } = h();
    await db.insert(users).values(baseUser);
    const run = (email: string) =>
      execFileP(
        process.execPath,
        ['--conditions=rootcamp-src', '--import', 'tsx', 'src/cli.ts', 'admin:grant', email],
        { cwd: API_DIR, env: { ...process.env, DATABASE_URL: databaseUrl } },
      );

    const ok = await run('ann@x.ru');
    expect(ok.stdout).toMatch(/granted/);

    await expect(run('nobody@x.ru')).rejects.toMatchObject({ code: 1 });
  }, 60_000);
});

describe('rootcamp-cli sandboxes:drain / sandboxes:undrain', () => {
  it('writes settings.sandboxes_drained (jsonb true/false) and audit_log rows', async () => {
    const { db } = h();
    const c = capture();
    expect(await runCli(['sandboxes:drain'], { db, ...c.io })).toBe(0);
    expect(c.out.join('\n')).toMatch(/drained/);
    const value = async () =>
      (await db.select().from(settings).where(eq(settings.key, 'sandboxes_drained')))[0]?.value;
    expect(await value()).toBe(true);

    expect(await runCli(['sandboxes:undrain'], { db, ...c.io })).toBe(0);
    expect(await value()).toBe(false);
    const audit = await db.select().from(auditLog).orderBy(auditLog.id);
    expect(audit.map((a) => a.action)).toEqual(['sandboxes.drain', 'sandboxes.undrain']);
    expect(audit.every((a) => a.actorId === null)).toBe(true);
  });
});
