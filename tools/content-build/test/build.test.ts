import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Catalog, Section } from '@rootcamp/content-schema';
import { loadContentTree, type ContentTree } from '@rootcamp/content-schema/node';
import { buildContent, writeContent } from '../src/build.js';
import { canonicalJson, contentHash } from '../src/hash.js';
import { runCli } from '../src/cli.js';

// The M1 `mini` fixture of packages/content-schema (track t9, practice inc-demo).
const MINI = fileURLToPath(
  new URL('../../../packages/content-schema/test/fixtures/mini', import.meta.url),
);
const MINI_CONTENT = join(MINI, 'content');
const CHECK = 'check/file-created.sh';

let tree: ContentTree;
beforeAll(async () => {
  tree = await loadContentTree(MINI_CONTENT);
  expect(tree.errors).toEqual([]);
});

/** Every object key anywhere in `v`. */
function allKeys(v: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, keys));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      allKeys(x, keys);
    }
  }
  return keys;
}

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('contentHash is the first 12 hex chars of sha256', () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('buildContent', () => {
  it('is deterministic: same tree, same 12-char hash', () => {
    const a = buildContent(tree);
    const b = buildContent(structuredClone(tree));
    expect(a.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(b.hash).toBe(a.hash);
  });

  it('changing one byte of a check script changes the hash', () => {
    const changed = structuredClone(tree);
    const files = changed.practices[0]!.files;
    files[CHECK] = files[CHECK]!.replace(/.$/s, (c) => (c === '\n' ? ' \n' : `${c} `));
    expect(files[CHECK]).not.toBe(tree.practices[0]!.files[CHECK]);
    expect(buildContent(changed).hash).not.toBe(buildContent(tree).hash);
  });

  it('public part has no server-only keys; catalog has no tasks', () => {
    const built = buildContent(tree);
    const keys = allKeys(built.public);
    for (const k of ['server', 'solution', 'setup', 'check', 'hints', 'image']) {
      expect(keys.has(k), k).toBe(false);
    }
    expect(Object.keys(built.public).sort()).toEqual([
      'catalog.json',
      'practices/inc-demo.json',
      'sections/t9.s01.json',
    ]);
    const catalog = built.public['catalog.json'] as Catalog;
    expect(allKeys(catalog).has('tasks')).toBe(false);
    expect(catalog.version).toBe(built.hash);
    expect(catalog.tracks.map((t) => t.id)).toEqual(['t9']);
    expect(catalog.tracks[0]!.sections[0]!.nodes).toHaveLength(5);
  });

  it('a practice node becomes lesson <section>.p-<id> with one terminal_practice task', () => {
    const built = buildContent(tree);
    const section = built.public['sections/t9.s01.json'] as Section;
    expect(section.lessons.map((l) => l.id)).toEqual([
      't9.s01.l01',
      't9.s01.l02',
      't9.s01.l03',
      't9.s01.l04',
      't9.s01.p-inc-demo',
    ]);
    const practice = section.lessons[4]!;
    expect(practice).toEqual({
      id: 't9.s01.p-inc-demo',
      kind: 'practice',
      title: tree.practices[0]!.manifest.title,
      tasks: [{ id: 't9.s01.p-inc-demo.t01', type: 'terminal_practice', practiceId: 'inc-demo' }],
    });
    const catalog = built.public['catalog.json'] as Catalog;
    expect(catalog.tracks[0]!.sections[0]!.nodes[4]).toEqual({
      kind: 'practice',
      lessonId: 't9.s01.p-inc-demo',
      practiceId: 'inc-demo',
      title: tree.practices[0]!.manifest.title,
    });
  });

  it('server part holds the full course and the practice scripts', () => {
    const built = buildContent(tree);
    expect(Object.keys(built.server).sort()).toEqual([
      'catalog.json',
      'practices/inc-demo/check/file-created.sh',
      'practices/inc-demo/check/service-running.sh',
      'practices/inc-demo/practice.json',
      'practices/inc-demo/setup.sh',
      'practices/inc-demo/solution.sh',
      'sections/t9.s01.json',
    ]);
    expect(built.server['practices/inc-demo/check/file-created.sh']).toBe(
      tree.practices[0]!.files[CHECK],
    );
    expect(built.server['practices/inc-demo/practice.json']).toEqual(tree.practices[0]!.manifest);
    expect(built.server['sections/t9.s01.json']).toEqual(built.public['sections/t9.s01.json']);
  });

  it('collects every published ID, sorted', () => {
    const { ids } = buildContent(tree);
    expect(ids).toEqual([...ids].sort());
    for (const id of ['t9', 't9.s01', 't9.s01.l01', 't9.s01.l01.t10', 'inc-demo']) {
      expect(ids).toContain(id);
    }
    expect(ids).toContain('t9.s01.p-inc-demo');
    expect(ids).toContain('t9.s01.p-inc-demo.t01');
  });

  it('skips draft tracks', () => {
    const draft = structuredClone(tree);
    draft.tracks[0]!.src.status = 'draft';
    const built = buildContent(draft);
    expect((built.public['catalog.json'] as Catalog).tracks).toEqual([]);
    expect(built.ids.some((id) => id.startsWith('t9'))).toBe(false);
    expect(Object.keys(built.public).some((k) => k.startsWith('sections/'))).toBe(false);
  });
});

describe('writeContent and the CLI', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes public/<hash>/ and server/<hash>/ trees', async () => {
    dir = await mkdtemp(join(tmpdir(), 'content-build-'));
    const built = buildContent(tree);
    await writeContent(built, dir);
    const pub = join(dir, 'public', built.hash);
    const catalog = JSON.parse(await readFile(join(pub, 'catalog.json'), 'utf8')) as Catalog;
    expect(catalog.version).toBe(built.hash);
    expect((await readdir(join(pub, 'practices'))).sort()).toEqual(['inc-demo.json']);
    const srv = join(dir, 'server', built.hash);
    expect(await readFile(join(srv, 'practices/inc-demo', CHECK), 'utf8')).toBe(
      tree.practices[0]!.files[CHECK],
    );
    // idempotent: writing the same version again succeeds
    await writeContent(built, dir);
    expect(await readdir(join(dir, 'public'))).toEqual([built.hash]);
  });

  it('build prints the version; --update-published-ids appends new IDs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'content-build-'));
    await cp(MINI, join(dir, 'src'), { recursive: true });
    const content = join(dir, 'src', 'content');
    await writeFile(join(content, 'published-ids.json'), '["t9"]\n');
    const lines: string[] = [];
    const out = (l: string) => void lines.push(l);

    expect(await runCli(['build', content, join(dir, 'dist')], { out })).toBe(0);
    const hash = buildContent(tree).hash;
    expect(lines).toContain(`version ${hash}`);
    expect(JSON.parse(await readFile(join(content, 'published-ids.json'), 'utf8'))).toEqual(['t9']);

    expect(
      await runCli(['build', content, join(dir, 'dist'), '--update-published-ids'], { out }),
    ).toBe(0);
    const ids = JSON.parse(await readFile(join(content, 'published-ids.json'), 'utf8'));
    expect(ids).toEqual(buildContent(tree).ids);
  });

  it('refuses to build invalid content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'content-build-'));
    await cp(MINI, join(dir, 'src'), { recursive: true });
    const content = join(dir, 'src', 'content');
    await writeFile(join(content, 'tracks/t9/s01/l02.yaml'), 'id: [broken');
    const lines: string[] = [];
    expect(
      await runCli(['build', content, join(dir, 'dist')], { out: (l) => void lines.push(l) }),
    ).toBe(1);
    expect(lines.some((l) => l.startsWith('error '))).toBe(true);
    await expect(readdir(join(dir, 'dist'))).rejects.toThrow();
  });

  it('bad usage exits 2', async () => {
    expect(await runCli(['build'], { out: () => {} })).toBe(2);
  });
});
