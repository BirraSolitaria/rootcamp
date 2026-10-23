import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The same compose project and files as `run.mjs`. */
const COMPOSE = [
  'compose',
  '-p',
  'rootcamp-e2e',
  '--env-file',
  'infra/versions.env',
  '-f',
  'infra/compose.yaml',
  '-f',
  'infra/compose.e2e.yaml',
];

/**
 * Runs `script` in psql inside the e2e stand's Postgres and returns its tuples-only output.
 * `vars` become psql variables (`:'name'` in the script quotes them as literals).
 */
export function psql(script: string, vars: Record<string, string> = {}): string {
  const args = [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'rootcamp', '-d', 'rootcamp'];
  args.push('-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1');
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const r = spawnSync('docker', args, {
    cwd: ROOT,
    input: script,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * «A day has passed» for the review boxes of `nick`: every due date moves one day back.
 * The server's clock is its own (`page.clock` only moves the browser's), so the e2e shifts the
 * stored dates instead. Returns how many items moved.
 */
export function shiftReviewDueDates(nick: string, days = 1): number {
  const out = psql(
    `with moved as (
       update review_items set due_date = due_date - :days
       where user_id = (select id from users where nick = :'nick')
       returning 1)
     select count(*) from moved;`,
    { nick, days: String(days) },
  );
  return Number(out);
}
