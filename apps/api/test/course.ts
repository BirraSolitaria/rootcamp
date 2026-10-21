// Builds real course content (repo content/ or the content-schema `mini` fixture) into a
// content-dist directory for tests, through tools/content-build.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContentTree, type ContentTree } from '@rootcamp/content-schema/node';
import { buildContent, writeContent } from 'content-build';

/** The repository's course (t1, t7). */
export const REPO_CONTENT = fileURLToPath(new URL('../../../content', import.meta.url));
/** M1 `mini` fixture: track t9 with practice inc-demo. */
export const MINI_CONTENT = fileURLToPath(
  new URL('../../../packages/content-schema/test/fixtures/mini/content', import.meta.url),
);

/** A fresh empty directory under the OS temp dir (created synchronously, usable at load time). */
export function tempContentDir(): string {
  return mkdtempSync(join(tmpdir(), 'rc-content-dist-'));
}

/**
 * Loads `contentRoot`, lets `mutate` change the tree (e.g. a title, to get another version),
 * builds it into `outDir/{public,server}/<hash>/` and returns the hash.
 */
export async function buildCourse(
  outDir: string,
  contentRoot = REPO_CONTENT,
  mutate?: (tree: ContentTree) => void,
): Promise<string> {
  const tree = await loadContentTree(contentRoot);
  if (tree.errors.length > 0) throw new Error(`content errors: ${JSON.stringify(tree.errors)}`);
  mutate?.(tree);
  const built = buildContent(tree);
  await writeContent(built, outDir);
  return built.hash;
}
