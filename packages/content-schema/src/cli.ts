import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContentTree } from './load.js';
import { defaultShellcheck, type ShellcheckRunner } from './shellcheck.js';
import { validateContent } from './validate.js';

export interface CliDeps {
  shellcheck: ShellcheckRunner;
  /** `YYYY-MM-DD`; defaults to the current UTC date. */
  today: string;
  out: (line: string) => void;
}

const USAGE = 'usage: cli validate <content-dir>';

/**
 * `validate <content-dir>`: prints `<severity> <rule> <path>: <message>` per
 * finding and a summary line. Exit code 1 on any error, 0 with warnings only,
 * 2 on bad usage.
 */
export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const [command, root, ...rest] = argv;
  if (command !== 'validate' || !root || rest.length > 0) {
    out(USAGE);
    return 2;
  }
  const tree = await loadContentTree(resolve(root));
  const findings = await validateContent(tree, {
    shellcheck: deps.shellcheck ?? defaultShellcheck(),
    today: deps.today ?? new Date().toISOString().slice(0, 10),
  });
  for (const f of findings) out(`${f.severity} ${f.rule} ${f.path}: ${f.message}`);
  const errors = findings.filter((f) => f.severity === 'error').length;
  out(`${errors} errors, ${findings.length - errors} warnings`);
  return errors > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
