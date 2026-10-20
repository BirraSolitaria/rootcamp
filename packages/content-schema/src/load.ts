import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  ImageRegistrySchema,
  LessonSrcSchema,
  PracticeManifestSchema,
  PublishedIdsSchema,
  RemovedIdsSchema,
  SectionSrcSchema,
  TrackSrcSchema,
  type ImageRegistry,
  type LessonSrc,
  type PracticeManifest,
  type SectionSrc,
  type TrackSrc,
} from './source.js';
import type { ValidationError } from './types.js';

/** Rule code for files that cannot be read, parsed or do not match the source schema. */
const LOAD_RULE = 'R7';
const PRACTICE_MANIFEST = 'practice.yaml';

export interface LoadedLesson {
  file: string;
  src: LessonSrc;
}
export interface LoadedSection {
  file: string;
  src: SectionSrc;
  lessons: LoadedLesson[];
}
export interface LoadedTrack {
  file: string;
  src: TrackSrc;
  sections: LoadedSection[];
}
export interface LoadedPractice {
  dir: string;
  manifest: PracticeManifest;
  /** Every file of the practice directory except practice.yaml: relpath (`/`) → content. */
  files: Record<string, string>;
}
export interface ContentTree {
  tracks: LoadedTrack[];
  practices: LoadedPractice[];
  removedIds: string[];
  publishedIds: string[];
  images: ImageRegistry;
  errors: ValidationError[];
}

export interface LoadOptions {
  /** Extra directories with `practices/` and `images/registry.yaml` (both optional there). */
  extraRoots?: string[];
}

/**
 * Loads the YAML sources under `root` (the `content/` directory). The image
 * registry is read from `<root>/../sandbox/images/registry.yaml`, as laid out in
 * the repository. Read, parse and schema failures are collected in `errors`
 * (rule R7) with the file path relative to `root`; they are never thrown.
 */
export async function loadContentTree(root: string, opts: LoadOptions = {}): Promise<ContentTree> {
  const ctx = new Loader(root);

  const tracks = await ctx.loadTracks();
  const practices = await ctx.loadPractices(join(root, 'practices'));
  const removed = await ctx.loadFile(join(root, 'removed-ids.yaml'), RemovedIdsSchema);
  const published = await ctx.loadFile(join(root, 'published-ids.json'), PublishedIdsSchema);
  const registry = await ctx.loadFile(
    join(root, '..', 'sandbox', 'images', 'registry.yaml'),
    ImageRegistrySchema,
  );
  const images: ImageRegistry = { images: [...(registry?.images ?? [])] };

  for (const extra of opts.extraRoots ?? []) {
    practices.push(...(await ctx.loadPractices(join(extra, 'practices'))));
    const extraRegistry = join(extra, 'images', 'registry.yaml');
    if ((await readText(extraRegistry)) !== undefined) {
      images.images.push(
        ...((await ctx.loadFile(extraRegistry, ImageRegistrySchema))?.images ?? []),
      );
    }
  }

  return {
    tracks,
    practices,
    removedIds: removed?.ids ?? [],
    publishedIds: published ?? [],
    images,
    errors: ctx.errors,
  };
}

class Loader {
  readonly errors: ValidationError[] = [];

  constructor(private readonly root: string) {}

  /** Path relative to the content root, with `/` separators. */
  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/');
  }

  fail(abs: string, message: string): void {
    this.errors.push({ path: this.rel(abs), rule: LOAD_RULE, message, severity: 'error' });
  }

  /** Reads, parses (YAML, which also covers JSON) and validates one file; undefined on failure. */
  async loadFile<S extends z.ZodType>(abs: string, schema: S): Promise<z.output<S> | undefined> {
    const text = await readText(abs);
    if (text === undefined) {
      this.fail(abs, 'file not found or unreadable');
      return undefined;
    }
    let data: unknown;
    try {
      data = parseYaml(text, { prettyErrors: true });
    } catch (e) {
      this.fail(abs, `YAML parse error: ${(e as Error).message}`);
      return undefined;
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
        .join('; ');
      this.fail(abs, `schema mismatch: ${issues}`);
      return undefined;
    }
    return result.data;
  }

  async loadTracks(): Promise<LoadedTrack[]> {
    const tracksDir = join(this.root, 'tracks');
    const tracks: LoadedTrack[] = [];
    for (const name of (await listDirs(tracksDir)) ?? []) {
      const trackDir = join(tracksDir, name);
      const trackFile = join(trackDir, 'track.yaml');
      const src = await this.loadFile(trackFile, TrackSrcSchema);
      if (!src) continue;
      const sections: LoadedSection[] = [];
      for (const sectionName of src.sections) {
        const section = await this.loadSection(join(trackDir, sectionName));
        if (section) sections.push(section);
      }
      tracks.push({ file: this.rel(trackFile), src, sections });
    }
    return tracks;
  }

  async loadSection(sectionDir: string): Promise<LoadedSection | undefined> {
    const sectionFile = join(sectionDir, 'section.yaml');
    const src = await this.loadFile(sectionFile, SectionSrcSchema);
    if (!src) return undefined;
    const lessons: LoadedLesson[] = [];
    for (const node of src.nodes) {
      if (!('lesson' in node)) continue;
      const lessonFile = join(sectionDir, `${node.lesson}.yaml`);
      const lesson = await this.loadFile(lessonFile, LessonSrcSchema);
      if (lesson) lessons.push({ file: this.rel(lessonFile), src: lesson });
    }
    return { file: this.rel(sectionFile), src, lessons };
  }

  /** Loads every `<dir>/<name>/practice.yaml`; a missing `dir` means no practices. */
  async loadPractices(dir: string): Promise<LoadedPractice[]> {
    const practices: LoadedPractice[] = [];
    for (const name of (await listDirs(dir)) ?? []) {
      const practiceDir = join(dir, name);
      const manifest = await this.loadFile(
        join(practiceDir, PRACTICE_MANIFEST),
        PracticeManifestSchema,
      );
      if (!manifest) continue;
      const files: Record<string, string> = {};
      for (const relPath of await listFiles(practiceDir)) {
        if (relPath === PRACTICE_MANIFEST) continue;
        const text = await readText(join(practiceDir, relPath));
        if (text === undefined) this.fail(join(practiceDir, relPath), 'file unreadable');
        else files[relPath] = text;
      }
      practices.push({ dir: this.rel(practiceDir), manifest, files });
    }
    return practices;
  }
}

/** UTF-8 text without BOM and with LF line endings; undefined if the file cannot be read. */
async function readText(abs: string): Promise<string | undefined> {
  try {
    const text = await readFile(abs, 'utf8');
    return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  } catch {
    return undefined;
  }
}

/** Sorted subdirectory names; undefined if `dir` does not exist or cannot be read. */
async function listDirs(dir: string): Promise<string[] | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return undefined;
  }
}

/** Sorted relative paths (`/` separators) of all files under `dir`. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}
