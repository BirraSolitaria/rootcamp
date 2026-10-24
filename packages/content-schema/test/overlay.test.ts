import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { loadContentTree, validateContent, type ContentTree } from '../src/node.js';

const MINI = fileURLToPath(new URL('./fixtures/mini', import.meta.url));
const MINI_CONTENT = join(MINI, 'content');
const CONTENT = fileURLToPath(new URL('../../../content', import.meta.url));
const E2E_FIXTURE = fileURLToPath(new URL('../../../e2e/fixtures/content', import.meta.url));

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** An extra root with practice `inc-extra` (a copy of inc-demo) and the given overlay files. */
async function extraRoot(overlays: Record<string, string>): Promise<string> {
  const extra = await mkdtemp(join(tmpdir(), 'rc-overlay-'));
  tmpDirs.push(extra);
  await cp(join(MINI_CONTENT, 'practices/inc-demo'), join(extra, 'practices/inc-extra'), {
    recursive: true,
  });
  const manifest = join(extra, 'practices/inc-extra/practice.yaml');
  const src = await readFile(manifest, 'utf8');
  await writeFile(manifest, src.replace('id: inc-demo', 'id: inc-extra'), 'utf8');
  await mkdir(join(extra, 'overlays'));
  for (const [name, text] of Object.entries(overlays)) {
    await writeFile(join(extra, 'overlays', name), text, 'utf8');
  }
  return extra;
}

function sectionNodes(tree: ContentTree, sectionId: string) {
  for (const track of tree.tracks) {
    for (const section of track.sections)
      if (section.src.id === sectionId) return section.src.nodes;
  }
  throw new Error(`no section ${sectionId}`);
}

const allPracticeNodes = (tree: ContentTree) =>
  tree.tracks.flatMap((t) => t.sections.flatMap((s) => s.src.nodes.filter((n) => 'practice' in n)));

describe('overlays/<sectionId>.yaml in extra roots', () => {
  test('inserts the practice node right after the named node', async () => {
    const extra = await extraRoot({ 't9.s01.yaml': 'insertAfter: l01\npractice: inc-extra\n' });

    const tree = await loadContentTree(MINI_CONTENT, { extraRoots: [extra] });

    expect(tree.errors).toEqual([]);
    expect(sectionNodes(tree, 't9.s01')).toEqual([
      { lesson: 'l01' },
      { practice: 'inc-extra' },
      { lesson: 'l02' },
      { lesson: 'l03' },
      { lesson: 'l04' },
      { practice: 'inc-demo' },
    ]);
  });

  test('an unknown section or anchor node is a load error (R7), nothing inserted', async () => {
    const extra = await extraRoot({
      't9.s07.yaml': 'insertAfter: l01\npractice: inc-extra\n',
      't9.s01.yaml': 'insertAfter: l09\npractice: inc-extra\n',
    });

    const tree = await loadContentTree(MINI_CONTENT, { extraRoots: [extra] });

    expect(tree.errors.map((e) => [e.rule, e.message])).toEqual([
      ['R7', expect.stringMatching(/l09/)],
      ['R7', expect.stringMatching(/t9\.s07/)],
    ]);
    expect(sectionNodes(tree, 't9.s01')).not.toContainEqual({ practice: 'inc-extra' });
  });

  test('a malformed overlay is a schema error (R7)', async () => {
    const extra = await extraRoot({ 't9.s01.yaml': 'after: l01\npractice: inc-extra\n' });

    const tree = await loadContentTree(MINI_CONTENT, { extraRoots: [extra] });

    expect(tree.errors).toHaveLength(1);
    expect(tree.errors[0]).toMatchObject({ rule: 'R7' });
    expect(tree.errors[0]!.message).toMatch(/schema mismatch/);
  });
});

describe('the e2e fixture (e2e/fixtures/content)', () => {
  test('with --extra: inc-e2e-touch follows t1.s01.l01 and the content validates', async () => {
    const tree = await loadContentTree(CONTENT, { extraRoots: [E2E_FIXTURE] });

    expect(tree.errors).toEqual([]);
    const nodes = sectionNodes(tree, 't1.s01');
    expect(nodes.slice(0, 3)).toEqual([
      { lesson: 'l01' },
      { practice: 'inc-e2e-touch' },
      { lesson: 'l02' },
    ]);
    const practice = tree.practices.find((p) => p.manifest.id === 'inc-e2e-touch');
    expect(practice?.manifest).toMatchObject({ image: 'rc/test-shell', class: 'light' });
    expect(tree.images.images).toContainEqual(
      expect.objectContaining({ ref: 'rc/test-shell', class: 'light' }),
    );
    const findings = await validateContent(tree, {
      shellcheck: async () => [],
      today: new Date().toISOString().slice(0, 10),
    });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  test('the working content/ without --extra has no trace of it', async () => {
    const tree = await loadContentTree(CONTENT);

    expect(tree.practices.map((p) => p.manifest.id)).not.toContain('inc-e2e-touch');
    expect(allPracticeNodes(tree)).not.toContainEqual({ practice: 'inc-e2e-touch' });
    expect(tree.images.images.map((i) => i.ref)).not.toContain('rc/test-shell');
  });
});
