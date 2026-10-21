import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Catalog,
  Lesson,
  PathNode,
  PracticePublic,
  Section,
  SectionRef,
  Track,
} from '@rootcamp/content-schema';
import type { ContentTree, LoadedPractice } from '@rootcamp/content-schema/node';
import { contentHash } from './hash.js';

export interface BuiltContent {
  /** Content version: first 12 hex chars of sha256 of the canonical JSON of the whole build. */
  hash: string;
  /** Files served to clients: relpath → JSON value. */
  public: Record<string, unknown>;
  /** Files read only by the api: relpath → JSON value, or raw text for practice scripts. */
  server: Record<string, string | unknown>;
  /** Every ID the build publishes, sorted. */
  ids: string[];
}

/**
 * Builds the course from a loaded (and validated) content tree. Draft tracks
 * are skipped, a `practice: <id>` node becomes the wrapper lesson
 * `<sectionId>.p-<id>` with one `terminal_practice` task. The hash covers both
 * the public and the server part, so editing any practice script yields a new
 * version. Throws on references the validator would have rejected.
 */
export function buildContent(tree: ContentTree): BuiltContent {
  const practices = new Map(tree.practices.map((p) => [p.manifest.id, p]));
  const ids = new Set<string>();
  const pub: Record<string, unknown> = {};
  const server: Record<string, string | unknown> = {};
  const tracks: Track[] = [];

  const published = tree.tracks
    .filter((t) => t.src.status !== 'draft')
    .sort((a, b) => a.src.order - b.src.order || a.src.id.localeCompare(b.src.id));
  const publishedTrackIds = new Set(published.map((t) => t.src.id));

  for (const { src: track, sections } of published) {
    ids.add(track.id);
    const refs: SectionRef[] = [];
    for (const { src: section, lessons: loaded } of sections) {
      ids.add(section.id);
      const byName = new Map(loaded.map((l) => [baseName(l.file), l.src]));
      const lessons: Lesson[] = [];
      const nodes: PathNode[] = [];
      for (const node of section.nodes) {
        if ('lesson' in node) {
          const src = byName.get(node.lesson);
          if (!src) throw new Error(`${section.id}: lesson '${node.lesson}' is not loaded`);
          lessons.push({
            id: src.id,
            kind: 'lesson',
            title: src.title,
            theory: src.theory,
            tasks: src.tasks,
          });
          nodes.push({ kind: 'lesson', lessonId: src.id, title: src.title });
          ids.add(src.id);
          for (const task of src.tasks) ids.add(task.id);
        } else {
          const practice = practices.get(node.practice);
          if (!practice) throw new Error(`${section.id}: practice '${node.practice}' not found`);
          const lessonId = `${section.id}.p-${node.practice}`;
          const title = practice.manifest.title;
          lessons.push({
            id: lessonId,
            kind: 'practice',
            title,
            tasks: [
              { id: `${lessonId}.t01`, type: 'terminal_practice', practiceId: node.practice },
            ],
          });
          nodes.push({ kind: 'practice', lessonId, practiceId: node.practice, title });
          ids.add(lessonId).add(`${lessonId}.t01`);
        }
      }
      const built: Section = {
        id: section.id,
        title: section.title,
        description: section.description,
        lessons,
      };
      pub[`sections/${section.id}.json`] = built;
      server[`sections/${section.id}.json`] = built;
      refs.push({
        id: section.id,
        title: section.title,
        description: section.description,
        lessonCount: lessons.length,
        nodes,
      });
    }
    tracks.push({
      id: track.id,
      order: track.order,
      title: track.title,
      description: track.description,
      status: track.status as Track['status'],
      prerequisites: track.prerequisites,
      reviewedAt: track.reviewedAt,
      sections: refs,
    });
  }

  for (const practice of [...tree.practices].sort((a, b) =>
    a.manifest.id.localeCompare(b.manifest.id),
  )) {
    if (!publishedTrackIds.has(practice.manifest.track)) continue;
    const id = practice.manifest.id;
    ids.add(id);
    pub[`practices/${id}.json`] = practicePublic(practice);
    server[`practices/${id}/practice.json`] = practice.manifest;
    for (const [rel, text] of Object.entries(practice.files)) {
      server[`practices/${id}/${rel}`] = text;
    }
  }

  // The version is part of catalog.json, so hash everything without it first.
  const hash = contentHash({ public: { ...pub, 'catalog.json': { tracks } }, server });
  const catalog: Catalog = { version: hash, tracks };
  pub['catalog.json'] = catalog;
  server['catalog.json'] = catalog;

  return { hash, public: pub, server, ids: [...ids].sort() };
}

/** Client-safe part of a practice manifest: no image, hints, check or setup scripts, solution. */
function practicePublic({ manifest: m }: LoadedPractice): PracticePublic {
  return {
    id: m.id,
    title: m.title,
    track: m.track,
    brief: m.brief,
    class: m.class,
    goals: m.goals.map((g) => ({ id: g.id, title: g.title })),
    hintCount: m.hints.length,
    reward: { base: m.reward.base, noHintBonus: m.reward.noHintBonus, hintCost: m.reward.hintCost },
    timeoutMin: m.timeoutMin,
  };
}

/** `tracks/t9/s01/l01.yaml` → `l01`. */
function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1).replace(/\.yaml$/, '');
}

/**
 * Writes `outDir/public/<hash>/…` and `outDir/server/<hash>/…`. Each tree is
 * written to a temporary sibling and renamed into place, so a reader never sees
 * a half-written version. An existing `<hash>` directory is replaced (same
 * hash means the same content).
 */
export async function writeContent(built: BuiltContent, outDir: string): Promise<void> {
  for (const [part, files] of [
    ['public', built.public],
    ['server', built.server],
  ] as const) {
    const target = join(outDir, part, built.hash);
    const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      for (const [rel, value] of Object.entries(files)) {
        const file = join(tmp, rel);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
      }
      if (await exists(target)) await rm(target, { recursive: true, force: true });
      await rename(tmp, target);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
