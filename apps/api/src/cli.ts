// rootcamp-cli: operator commands run inside the api container, e.g.
//   docker compose exec api node dist/cli.js admin:grant ann@mail.ru
// Needs only DATABASE_URL (the api container already has it).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditLog, createDb, users, type Db } from '@rootcamp/db';
import { Command, CommanderError } from 'commander';
import { sql } from 'drizzle-orm';

export interface CliDeps {
  db: Db;
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
