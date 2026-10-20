import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadContentTree, validateContent } from '../src/node.js';

const CONTENT = fileURLToPath(new URL('../../../content', import.meta.url));

// Scripts are linted by `pnpm content:validate` (real shellcheck); here a clean
// runner keeps the test independent of a shellcheck binary. Warnings (R21) are
// allowed, as in the CLI.
it('the current content/ has no validation errors', async () => {
  const tree = await loadContentTree(CONTENT);
  const findings = await validateContent(tree, {
    shellcheck: async () => [],
    today: new Date().toISOString().slice(0, 10),
  });
  expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
});
