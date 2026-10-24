// rootcamp-cli: operator commands run inside the api container, e.g.
//   docker compose exec api node dist/cli.js admin:grant ann@mail.ru
//   docker compose exec api node dist/cli.js content:list
//   docker compose exec api node dist/cli.js content:activate <hash>
//   docker compose exec api node dist/cli.js sandboxes:drain    (before maintenance, spec §11.5)
//   docker compose exec api node dist/cli.js dev:seed-progress ann@mail.ru t1.s01.l01
//                                            (dev/e2e stands only: refused unless NODE_ENV is
//                                            development or test)
// Needs DATABASE_URL and, for content:*, CONTENT_DIR (the api container has both).
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE } from '@rootcamp/content-schema';
import { auditLog, createDb, lessonCompletions, users, type Db } from '@rootcamp/db';
import { Command, CommanderError } from 'commander';
import { sql } from 'drizzle-orm';
import {
  CONTENT_CHANNEL,
  CONTENT_HASH,
  CONTENT_VERSION_KEY,
  loadContentStore,
} from './services/contentStore.js';
import { getSetting, setSetting } from './services/settings.js';

export interface CliDeps {
  db: Db;
  /** content-dist root (`CONTENT_DIR`) holding `server/<hash>/` and `public/<hash>/`. */
  contentDir?: string;
  /** `NODE_ENV`; unset counts as production (as in the api config). Gates the `dev:*` commands. */
  nodeEnv?: string;
  out(line: string): void;
  err(line: string): void;
}

/** Thrown by a command to end the run with a message on stderr and a non-zero exit code. */
class CliFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/**
 * Sets `users.is_admin` for `email` (citext: case-insensitive) and records `admin.grant` in
 * `audit_log` with `actor_id = null` (an operator, not a user, did it) — in one transaction.
 */
async function adminGrant(db: Db, email: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ isAdmin: true })
      .where(sql`${users.email} = ${email}`)
      .returning({ id: users.id, email: users.email });
    if (!user) throw new CliFailure(`no user with email ${email}`);
    await tx.insert(auditLog).values({
      actorId: null,
      action: 'admin.grant',
      targetId: user.id,
      data: { email: user.email, via: 'cli' },
    });
    return `granted admin to ${user.email} (${user.id})`;
  });
}

function requireContentDir(deps: CliDeps): string {
  if (!deps.contentDir) throw new CliFailure('CONTENT_DIR is not set');
  return deps.contentDir;
}

/**
 * Makes `hash` the active content version: checks that `server/<hash>/` loads, then in one
 * transaction writes `settings.content_version`, an `audit_log` row and `NOTIFY rc_content`
 * (delivered on commit), on which every api process reloads.
 */
async function contentActivate(db: Db, dir: string, hash: string): Promise<string> {
  if (!CONTENT_HASH.test(hash)) throw new CliFailure(`invalid version "${hash}" (12 hex chars)`);
  try {
    await loadContentStore(dir, hash);
  } catch (e) {
    throw new CliFailure(`version ${hash} is not installed in ${dir}: ${(e as Error).message}`);
  }
  await db.transaction(async (tx) => {
    await setSetting(tx, CONTENT_VERSION_KEY, hash);
    await tx.insert(auditLog).values({
      actorId: null,
      action: 'content.activate',
      targetId: hash,
      data: { via: 'cli' },
    });
    await tx.execute(sql`select pg_notify(${CONTENT_CHANNEL}, ${hash})`);
  });
  return `activated ${hash}`;
}

/** Version directories under `dir/part` (empty when it does not exist). */
async function versionsIn(dir: string, part: 'server' | 'public'): Promise<string[]> {
  try {
    const entries = await readdir(join(dir, part), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && CONTENT_HASH.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Installed versions (`server/<hash>/`), the active one marked. */
async function contentList(db: Db, dir: string): Promise<string[]> {
  const active = await getSetting<string | null>(db, CONTENT_VERSION_KEY, null);
  const installed = await versionsIn(dir, 'server');
  const lines = installed.map((h) => (h === active ? `${h} (active)` : h));
  if (active && !installed.includes(active)) lines.push(`${active} (active, NOT INSTALLED)`);
  if (lines.length === 0) lines.push('no content versions installed');
  return lines;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies every `<src>/{server,public}/<hash>/` missing from `dir` (server parts first, so a
 * public version always has its server part). Each copy is assembled under `dir/.tmp-*` and
 * renamed into place; existing versions are kept as they are (same hash = same content).
 */
async function contentInstall(src: string, dir: string): Promise<string[]> {
  const from = resolve(src);
  const hashes = new Set([
    ...(await versionsIn(from, 'server')),
    ...(await versionsIn(from, 'public')),
  ]);
  if (hashes.size === 0) throw new CliFailure(`no content versions in ${from}`);
  const tmpRoot = join(dir, `.tmp-${randomBytes(4).toString('hex')}`);
  const lines: string[] = [];
  try {
    for (const hash of [...hashes].sort()) {
      let copied = false;
      for (const part of ['server', 'public'] as const) {
        const source = join(from, part, hash);
        const target = join(dir, part, hash);
        if (!(await exists(source)) || (await exists(target))) continue;
        const tmp = join(tmpRoot, part, hash);
        await cp(source, tmp, { recursive: true });
        await mkdir(join(dir, part), { recursive: true });
        await rename(tmp, target);
        copied = true;
      }
      lines.push(copied ? `installed ${hash}` : `already installed ${hash}`);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
  return lines;
}

/** `settings` key read by sandboxd's scheduler on every tick and every user enqueue. */
export const SANDBOXES_DRAINED_KEY = 'sandboxes_drained';

/**
 * Writes `settings.sandboxes_drained` and an `audit_log` row (`sandboxes.drain`/`.undrain`,
 * actor null) in one transaction. Drained: sandboxd admits nothing new and refuses user creates
 * with `queue_full`; running sandboxes live out their time.
 */
async function sandboxesDrain(db: Db, drained: boolean): Promise<string> {
  await db.transaction(async (tx) => {
    await setSetting(tx, SANDBOXES_DRAINED_KEY, drained);
    await tx.insert(auditLog).values({
      actorId: null,
      action: drained ? 'sandboxes.drain' : 'sandboxes.undrain',
      targetId: null,
      data: { via: 'cli' },
    });
  });
  return drained
    ? 'sandboxes drained: no new sandboxes start, running ones live out their time'
    : 'sandboxes undrained: new sandboxes start again';
}

/**
 * Marks `lessonIds` completed for the user with `email` (`lesson_completions`, 0 mistakes; rows
 * that exist are kept), so a dev or e2e stand can open what those lessons unlock without playing
 * them. No XP, streak or review items. Only with NODE_ENV development or test.
 */
async function seedProgress(
  db: Db,
  nodeEnv: string | undefined,
  email: string,
  lessonIds: string[],
): Promise<string> {
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new CliFailure(
      `dev:seed-progress is refused with NODE_ENV=${nodeEnv ?? '(unset: production)'}`,
    );
  }
  const bad = lessonIds.filter((id) => !ID_RE.lesson.test(id));
  if (bad.length > 0) throw new CliFailure(`not a lesson id: ${bad.join(', ')}`);
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`${users.email} = ${email}`);
  if (!user) throw new CliFailure(`no user with email ${email}`);
  await db
    .insert(lessonCompletions)
    .values(lessonIds.map((lessonId) => ({ userId: user.id, lessonId, bestMistakes: 0 })))
    .onConflictDoNothing();
  return `seeded ${lessonIds.length} completed lesson(s) for ${user.email}`;
}

function buildProgram(deps: CliDeps): Command {
  const program = new Command('rootcamp-cli')
    .description('rootcamp operator commands')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.out(s.trimEnd()),
      writeErr: (s) => deps.err(s.trimEnd()),
    });
  program
    .command('admin:grant')
    .description('make the user with this email an administrator')
    .argument('<email>', 'account email')
    .action(async (email: string) => {
      deps.out(await adminGrant(deps.db, email));
    });
  program
    .command('content:list')
    .description('list content versions installed in CONTENT_DIR and the active one')
    .action(async () => {
      for (const line of await contentList(deps.db, requireContentDir(deps))) deps.out(line);
    });
  program
    .command('content:install')
    .description('copy content versions from a content-dist directory into CONTENT_DIR')
    .argument('<dir>', 'content-dist directory with server/<hash>/ and public/<hash>/')
    .action(async (src: string) => {
      for (const line of await contentInstall(src, requireContentDir(deps))) deps.out(line);
    });
  program
    .command('content:activate')
    .description('make an installed content version active (api processes reload at once)')
    .argument('<hash>', 'content version, as printed by content-build or content:list')
    .action(async (hash: string) => {
      deps.out(await contentActivate(deps.db, requireContentDir(deps), hash));
    });
  program
    .command('sandboxes:drain')
    .description('stop admitting new sandboxes (running ones live out their time)')
    .action(async () => {
      deps.out(await sandboxesDrain(deps.db, true));
    });
  program
    .command('sandboxes:undrain')
    .description('admit new sandboxes again')
    .action(async () => {
      deps.out(await sandboxesDrain(deps.db, false));
    });
  program
    .command('dev:seed-progress')
    .description('dev/e2e only: mark lessons completed for a user (refused in production)')
    .argument('<email>', 'account email')
    .argument('<lessonIds...>', 'lesson ids, e.g. t1.s01.l01')
    .action(async (email: string, lessonIds: string[]) => {
      deps.out(await seedProgress(deps.db, deps.nodeEnv, email, lessonIds));
    });
  return program;
}

/** Runs one command; `argv` excludes the node and script paths. Resolves to the exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  try {
    await buildProgram(deps).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CliFailure) {
      deps.err(e.message);
      return e.exitCode;
    }
    // --help / --version end through exitOverride with exitCode 0; usage errors with 1.
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is required');
    return 1;
  }
  const handle = createDb(url, { max: 1 });
  try {
    return await runCli(process.argv.slice(2), {
      db: handle.db,
      contentDir: process.env.CONTENT_DIR?.trim() || undefined,
      nodeEnv: process.env.NODE_ENV?.trim() || undefined,
      out: (s) => console.log(s),
      err: (s) => console.error(s),
    });
  } catch (e) {
    console.error(e);
    return 1;
  } finally {
    await handle.close();
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
