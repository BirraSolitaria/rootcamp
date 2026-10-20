/* global console, process, URL */
// `pnpm e2e`: bring up the e2e stand, run Playwright, always tear the stand down (`down -v`),
// exit with Playwright's code. Extra arguments go to `playwright test`
// (e.g. `pnpm e2e --project=mobile`). E2E_KEEP_STAND=1 skips the teardown for debugging.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));

const compose = [
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

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // shell on Windows: pnpm/docker are .cmd/.exe shims found through PATH.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

// Ctrl+C stops the child (same process group); the stand is still torn down below.
process.on('SIGINT', () => {});

let code = 1;
try {
  code = run('docker', [...compose, 'up', '-d', '--build', '--wait'], root);
  if (code !== 0) {
    run('docker', [...compose, 'logs', '--no-color', '--tail', '200'], root);
  } else {
    code = run('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], here);
    if (code !== 0) run('docker', [...compose, 'logs', '--no-color', '--tail', '200', 'api'], root);
  }
} finally {
  if (process.env.E2E_KEEP_STAND === '1') {
    console.log('\nE2E_KEEP_STAND=1: the stand stays up (tear down with `down -v`).');
  } else {
    run('docker', [...compose, 'down', '-v', '--remove-orphans'], root);
  }
}
process.exit(code);
