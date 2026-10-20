import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { loadContentTree } from '../src/node.js';

const MINI = fileURLToPath(new URL('./fixtures/mini', import.meta.url));
const MINI_CONTENT = join(MINI, 'content');
const LESSON_L01 = 'tracks/t9/s01/l01.yaml';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Copies the whole mini fixture (content/ + sandbox/) to a temp dir; returns its content root. */
async function copyMini(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rc-load-'));
  tmpDirs.push(dir);
  await cp(MINI, dir, { recursive: true });
  return join(dir, 'content');
}

describe('loadContentTree', () => {
  test('loads the mini fixture without errors', async () => {
    const tree = await loadContentTree(MINI_CONTENT);

    expect(tree.errors).toEqual([]);
    expect(tree.tracks).toHaveLength(1);
    const track = tree.tracks[0]!;
    expect(track.file).toBe('tracks/t9/track.yaml');
    expect(track.src.id).toBe('t9');
    expect(track.src.reviewedAt).toBe('2026-10-20');
    expect(track.sections).toHaveLength(1);
    const section = track.sections[0]!;
    expect(section.file).toBe('tracks/t9/s01/section.yaml');
    expect(section.src.nodes).toContainEqual({ practice: 'inc-demo' });
    expect(section.lessons.map((l) => l.file)).toEqual([
      'tracks/t9/s01/l01.yaml',
      'tracks/t9/s01/l02.yaml',
      'tracks/t9/s01/l03.yaml',
      'tracks/t9/s01/l04.yaml',
    ]);
    for (const lesson of section.lessons) expect(lesson.src.tasks).toHaveLength(10);

    expect(tree.practices).toHaveLength(1);
    const practice = tree.practices[0]!;
    expect(practice.dir).toBe('practices/inc-demo');
    expect(practice.manifest.id).toBe('inc-demo');
    expect(practice.manifest.innerImages).toEqual([]);
    expect(practice.manifest.goals.every((g) => g.timeoutSec >= 1)).toBe(true);
    expect(Object.keys(practice.files).sort()).toEqual([
      'check/file-created.sh',
      'check/service-running.sh',
      'setup.sh',
      'solution.sh',
    ]);
    expect(practice.files['setup.sh']).toMatch(/^#!\/bin\/sh/);

    expect(tree.removedIds).toEqual([]);
    expect(tree.publishedIds).toEqual([]);
    expect(tree.images.images.map((i) => i.ref)).toEqual(['rc/linux-base:24.04']);
  });

  test('a lesson saved with BOM and CRLF loads like a normal file', async () => {
    const root = await copyMini();
    const file = join(root, LESSON_L01);
    const lf = await readFile(file, 'utf8');
    expect(lf).not.toContain('\r');
    await writeFile(file, '\uFEFF' + lf.replace(/\n/g, '\r\n'), 'utf8');

    const normal = await loadContentTree(MINI_CONTENT);
    const windows = await loadContentTree(root);

    expect(windows.errors).toEqual([]);
    expect(windows.tracks[0]!.sections[0]!.lessons[0]!.src).toEqual(
      normal.tracks[0]!.sections[0]!.lessons[0]!.src,
    );
  });

  test('broken YAML is reported as R7 with the file path, not thrown', async () => {
    const root = await copyMini();
    await writeFile(join(root, LESSON_L01), 'id: t9.s01.l01\ntitle: [unclosed\n', 'utf8');

    const tree = await loadContentTree(root);

    expect(tree.errors.length).toBeGreaterThan(0);
    expect(tree.errors[0]!.rule).toBe('R7');
    expect(tree.errors[0]!.severity).toBe('error');
    expect(tree.errors[0]!.path).toContain('l01.yaml');
    expect(tree.tracks[0]!.sections[0]!.lessons.map((l) => l.file)).not.toContain(LESSON_L01);
  });

  test('schema mismatch is reported as R7 with the file path', async () => {
    const root = await copyMini();
    const file = join(root, 'practices/inc-demo/practice.yaml');
    const src = await readFile(file, 'utf8');
    await writeFile(file, src.replace(/^timeoutMin: \d+$/m, 'timeoutMin: 90'), 'utf8');

    const tree = await loadContentTree(root);

    expect(tree.practices).toEqual([]);
    expect(tree.errors).toHaveLength(1);
    expect(tree.errors[0]).toMatchObject({ rule: 'R7', path: 'practices/inc-demo/practice.yaml' });
    expect(tree.errors[0]!.message).toContain('timeoutMin');
  });

  test('a section listed in track.yaml but missing on disk is an R7 error', async () => {
    const root = await copyMini();
    const file = join(root, 'tracks/t9/track.yaml');
    const src = await readFile(file, 'utf8');
    await writeFile(file, src.replace('sections: [s01]', 'sections: [s01, s02]'), 'utf8');

    const tree = await loadContentTree(root);

    expect(tree.errors).toHaveLength(1);
    expect(tree.errors[0]).toMatchObject({ rule: 'R7', path: 'tracks/t9/s02/section.yaml' });
    expect(tree.tracks[0]!.sections).toHaveLength(1);
  });

  test('extraRoots add practices and images', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'rc-extra-'));
    tmpDirs.push(extra);
    await cp(join(MINI_CONTENT, 'practices/inc-demo'), join(extra, 'practices/inc-extra'), {
      recursive: true,
    });
    const manifest = join(extra, 'practices/inc-extra/practice.yaml');
    const src = await readFile(manifest, 'utf8');
    await writeFile(manifest, src.replace('id: inc-demo', 'id: inc-extra'), 'utf8');
    await cp(join(MINI, 'sandbox/images'), join(extra, 'images'), { recursive: true });
    const registry = join(extra, 'images/registry.yaml');
    const reg = await readFile(registry, 'utf8');
    await writeFile(registry, reg.replace('rc/linux-base:24.04', 'rc/e2e:1'), 'utf8');

    const tree = await loadContentTree(MINI_CONTENT, { extraRoots: [extra] });

    expect(tree.errors).toEqual([]);
    expect(tree.practices.map((p) => p.manifest.id)).toEqual(['inc-demo', 'inc-extra']);
    expect(tree.practices[1]!.dir).toMatch(/practices\/inc-extra$/);
    expect(tree.images.images.map((i) => i.ref)).toEqual(['rc/linux-base:24.04', 'rc/e2e:1']);
  });
});
