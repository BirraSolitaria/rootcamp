import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// packages/logic/src must stay pure: no UI, no Node built-ins, no I/O.
const NODE_BUILTIN =
  /^(node:.*|fs|path|os|child_process|net|http|https|crypto|stream|process|worker_threads)(\/.*)?$/;
// UI packages and content-schema's Node-only entry (fs, child_process).
const FORBIDDEN_PACKAGES =
  /^(react|react-dom|react-native|@rootcamp\/content-schema\/node)(\/.*)?$/;
// I/O and ambient-runtime APIs that must not appear inside logic sources.
const FORBIDDEN_CALLS =
  /\b(fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|require)\s*\(|\bprocess\.|\bDate\.now\s*\(|\bMath\.random\s*\(/g;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// `import … from 'x'` / `export … from 'x'` (possibly multi-line), `import 'x'`, `import('x')`, `require('x')`.
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function extractSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

function findViolations(source: string): string[] {
  const specs = extractSpecifiers(source).filter(
    (spec) => NODE_BUILTIN.test(spec) || FORBIDDEN_PACKAGES.test(spec),
  );
  const calls = [...source.matchAll(FORBIDDEN_CALLS)].map((m) => m[0]);
  return [...specs, ...calls];
}

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectTsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

test('detector flags forbidden imports and I/O', () => {
  expect(findViolations("import { useState } from 'react';")).toEqual(['react']);
  expect(findViolations("import { readFileSync } from 'node:fs';")).toEqual(['node:fs']);
  expect(findViolations("import * as fs from 'fs';")).toEqual(['fs']);
  expect(findViolations("const r = await fetch('/api');")).toEqual(['fetch(']);
  expect(findViolations('const now = Date.now();')).toEqual(['Date.now(']);
  expect(findViolations("import x from './dates.js';")).toEqual([]);
  expect(findViolations("import { normalize } from '@rootcamp/content-schema';")).toEqual([]);
  expect(
    findViolations("import { loadContentTree } from '@rootcamp/content-schema/node';"),
  ).toEqual(['@rootcamp/content-schema/node']);
});

test('packages/logic/src has no forbidden imports or I/O', () => {
  const files = collectTsFiles(SRC);
  expect(files.length).toBeGreaterThan(0);
  const violations = files.flatMap((file) =>
    findViolations(readFileSync(file, 'utf8')).map((v) => `${relative(SRC, file)}: ${v}`),
  );
  expect(violations).toEqual([]);
});

// logic is bundled into the browser, so everything it reaches through
// content-schema's `.` entry must be free of Node built-ins as well.
const CONTENT_SCHEMA = resolve(SRC, '..', '..', 'content-schema');

function sourceEntry(pkgDir: string, subpath: string): string {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    exports: Record<string, Record<string, string>>;
  };
  const target = pkg.exports[subpath]?.['rootcamp-src'];
  if (!target) throw new Error(`${pkgDir}: no rootcamp-src export for ${subpath}`);
  return resolve(pkgDir, target);
}

/** Bare (non-relative) specifiers reachable from `entry` via relative imports, keyed by importing file. */
function reachableBareImports(entry: string): { file: string; spec: string }[] {
  const seen = new Set<string>();
  const found: { file: string; spec: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of extractSpecifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) {
        found.push({ file, spec });
        continue;
      }
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (!existsSync(target)) throw new Error(`${file}: cannot resolve ${spec}`);
      queue.push(target);
    }
  }
  return found;
}

test('content-schema `.` entry reaches no Node built-ins', () => {
  const imports = reachableBareImports(sourceEntry(CONTENT_SCHEMA, '.'));
  expect(imports.length).toBeGreaterThan(0);
  const violations = imports
    .filter(({ spec }) => NODE_BUILTIN.test(spec))
    .map(({ file, spec }) => `${relative(CONTENT_SCHEMA, file)}: ${spec}`);
  expect(violations).toEqual([]);
});

test('import-graph walk sees Node built-ins behind the `./node` entry', () => {
  const imports = reachableBareImports(sourceEntry(CONTENT_SCHEMA, './node'));
  expect(imports.map(({ spec }) => spec)).toEqual(
    expect.arrayContaining(['node:fs/promises', 'node:child_process']),
  );
});
