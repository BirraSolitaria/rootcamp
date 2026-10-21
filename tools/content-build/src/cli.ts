import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContentTree, validateContent } from '@rootcamp/content-schema/node';
import { buildContent, writeContent } from './build.js';

export interface CliDeps {
  out: (line: string) => void;
  /** `YYYY-MM-DD` for the validator's reviewedAt check; defaults to the current UTC date. */
  today: string;
}

const USAGE =
  'usage: content-build build <content-dir> <out-dir> [--update-published-ids] [--extra <dir>]...';

/**
 * `build <content-dir> <out-dir>`: loads and validates the content (shellcheck
 * is left to `content:validate`), builds it and writes `<out-dir>/{public,server}/<hash>/`.
 * Prints `version <hash>` on success. `--update-published-ids` merges the built
 * IDs into `<content-dir>/published-ids.json`; `--extra <dir>` adds practices and
 * images from another root (e.g. e2e fixtures). Relative paths resolve against
 * the directory pnpm was started from (INIT_CWD). Exit 1 on content errors, 2 on bad usage.
 */
export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const positional: string[] = [];
  const extra: string[] = [];
  let updateIds = false;
  let badFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--update-published-ids') updateIds = true;
    else if (arg === '--extra' && argv[i + 1] !== undefined) extra.push(argv[++i]!);
    else if (arg.startsWith('--')) badFlag = true;
    else positional.push(arg);
  }
  const [command, contentArg, outArg] = positional;
  if (badFlag || command !== 'build' || !contentArg || !outArg || positional.length !== 3) {
    out(USAGE);
    return 2;
  }
  const base = process.env.INIT_CWD ?? process.cwd();
  const contentDir = resolve(base, contentArg);
  const outDir = resolve(base, outArg);

  const tree = await loadContentTree(contentDir, {
    extraRoots: extra.map((e) => resolve(base, e)),
  });
  const findings = await validateContent(tree, {
    shellcheck: async () => [],
    today: deps.today ?? new Date().toISOString().slice(0, 10),
  });
  const errors = findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    for (const f of errors) out(`${f.severity} ${f.rule} ${f.path}: ${f.message}`);
    out(`${errors.length} errors: build aborted (run content:validate)`);
    return 1;
  }

  const built = buildContent(tree);
  await writeContent(built, outDir);
  const catalog = built.public['catalog.json'] as { tracks: { id: string }[] };
  out(`tracks ${catalog.tracks.map((t) => t.id).join(', ') || '(none)'}`);

  if (updateIds) {
    const merged = [...new Set([...tree.publishedIds, ...built.ids])].sort();
    const added = merged.length - new Set(tree.publishedIds).size;
    await writeFile(join(contentDir, 'published-ids.json'), `${JSON.stringify(merged, null, 2)}\n`);
    out(`published-ids.json: +${added} ids (${merged.length} total)`);
  }
  out(`version ${built.hash}`);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
