import { execFileSync, execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Built packages must be consumable by plain `node` (as in `pnpm deploy --prod`
// images): without the `rootcamp-src` condition the exports resolve to dist/*.js.
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

function plainNode(script: string): string {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // no inherited --conditions / loaders
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PKG,
    env,
    encoding: 'utf8',
  });
}

test('built @rootcamp/logic resolves to dist and loads under plain node', () => {
  // Via shell so Windows resolves the pnpm.cmd shim (execFile can't spawn .cmd).
  execSync('pnpm --filter @rootcamp/logic... build', { cwd: PKG, stdio: 'pipe' });
  const out = JSON.parse(
    plainNode(`
      const logic = await import('@rootcamp/logic');
      console.log(JSON.stringify({
        logic: import.meta.resolve('@rootcamp/logic'),
        schema: import.meta.resolve('@rootcamp/content-schema'),
        schemaNode: import.meta.resolve('@rootcamp/content-schema/node'),
        maxHearts: logic.MAX_HEARTS,
        normalized: logic.normalize('  Docker  RUN '),
      }));
    `),
  ) as Record<string, unknown>;
  expect(out.logic).toMatch(/\/packages\/logic\/dist\/index\.js$/);
  expect(out.schema).toMatch(/\/packages\/content-schema\/dist\/index\.js$/);
  expect(out.schemaNode).toMatch(/\/packages\/content-schema\/dist\/node\.js$/);
  expect(out.maxHearts).toBe(5);
  expect(typeof out.normalized).toBe('string');
}, 120_000);
