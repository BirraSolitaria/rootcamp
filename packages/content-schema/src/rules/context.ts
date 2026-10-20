import type { ContentTree, LoadedLesson, LoadedSection, LoadedTrack } from '../load.js';
import type { ValidationError } from '../types.js';

// Shared helpers for the rule modules. The tree is typed, but rules must not
// throw on values the types rule out (the validator also runs on hand-built
// trees in tests), so field access goes through these guards.

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';
export const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const pad2 = (n: number): string => String(n).padStart(2, '0');
export const hasDuplicates = (xs: string[]): boolean => new Set(xs).size !== xs.length;

const CYRILLIC = /[А-Яа-яЁё]/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `file#field` locator used in every error path. */
export const at = (file: string, field?: string): string => (field ? `${file}#${field}` : file);
/** Parent directory of a `/`-separated relative path. */
export const dirOf = (file: string): string => file.slice(0, file.lastIndexOf('/'));
/** Base name without extension: `tracks/t9/s01/l01.yaml` → `l01`. */
export const stemOf = (file: string): string =>
  file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');

/** Days since 1970-01-01 for a valid `YYYY-MM-DD`, else undefined. */
export function dayNumber(v: unknown): number | undefined {
  if (!isStr(v) || !DATE_RE.test(v)) return undefined;
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) return undefined;
  return ms / DAY_MS;
}

export interface RuleContext {
  tree: ContentTree;
  today: string;
  error(rule: string, path: string, message: string): void;
  warn(rule: string, path: string, message: string): void;
}

export function makeContext(tree: ContentTree, today: string, out: ValidationError[]): RuleContext {
  return {
    tree,
    today,
    error: (rule, path, message) => out.push({ rule, path, message, severity: 'error' }),
    warn: (rule, path, message) => out.push({ rule, path, message, severity: 'warning' }),
  };
}

/** R5: a required non-empty string with optional length bounds. Returns whether it is a string. */
export function reqStr(
  ctx: RuleContext,
  v: unknown,
  path: string,
  bounds: { min?: number; max?: number } = {},
): v is string {
  if (!isStr(v) || v.trim() === '') {
    ctx.error('R5', path, 'обязательная строка отсутствует или пуста');
    return false;
  }
  if (bounds.max !== undefined && v.length > bounds.max) {
    ctx.error('R5', path, `длина ${v.length} > ${bounds.max}`);
  }
  if (bounds.min !== undefined && v.length < bounds.min) {
    ctx.error('R5', path, `длина ${v.length} < ${bounds.min}`);
  }
  return true;
}

/** R6: a non-empty text must contain at least one Cyrillic letter. */
export function cyr(ctx: RuleContext, v: unknown, path: string): void {
  if (isStr(v) && v.trim() !== '' && !CYRILLIC.test(v)) {
    ctx.error('R6', path, 'нет ни одной кириллической буквы');
  }
}

export interface LessonVisit {
  track: LoadedTrack;
  section: LoadedSection;
  lesson: LoadedLesson;
  /** The lesson source as an untyped object (rules re-check every field). */
  src: Obj;
}

/** Every loaded lesson in tree order. */
export function* lessons(tree: ContentTree): Generator<LessonVisit> {
  for (const track of tree.tracks) {
    for (const section of track.sections) {
      for (const lesson of section.lessons) {
        if (isObj(lesson.src)) yield { track, section, lesson, src: lesson.src };
      }
    }
  }
}

/** Every string inside `v`, with its dotted/indexed path relative to `v`. */
export function* strings(v: unknown, path = ''): Generator<[string, string]> {
  if (isStr(v)) yield [path, v];
  else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield* strings(v[i], `${path}[${i}]`);
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) yield* strings(x, path ? `${path}.${k}` : k);
  }
}
