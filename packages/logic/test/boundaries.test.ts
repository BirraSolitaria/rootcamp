import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// packages/logic/src must stay pure: no UI, no Node built-ins, no I/O.
const FORBIDDEN =
  /^(react|react-dom|react-native|node:.*|fs|fs\/.*|path|os|child_process|net|http|https|crypto|stream|process|worker_threads)(\/.*)?$/;
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
  const specs = extractSpecifiers(source).filter((spec) => FORBIDDEN.test(spec));
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
});

test('packages/logic/src has no forbidden imports or I/O', () => {
  const files = collectTsFiles(SRC);
  expect(files.length).toBeGreaterThan(0);
  const violations = files.flatMap((file) =>
    findViolations(readFileSync(file, 'utf8')).map((v) => `${relative(SRC, file)}: ${v}`),
  );
  expect(violations).toEqual([]);
});
