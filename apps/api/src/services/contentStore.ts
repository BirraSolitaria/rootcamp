// Active course content (spec §3.5): the api reads `CONTENT_DIR/server/<hash>/`, written by
// tools/content-build. The active hash lives in `settings.content_version`; `content:activate`
// writes it and sends `NOTIFY rc_content`, on which every api process reloads.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  Catalog,
  Lesson,
  PracticeManifest,
  Section,
  Task,
  Track,
} from '@rootcamp/content-schema';
import type { Db } from '@rootcamp/db';
import { isTrackComplete, type CourseIndex } from '@rootcamp/logic';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError } from '../plugins/errors.js';
import { getSetting } from './settings.js';

/** `settings` key holding the active content hash. */
export const CONTENT_VERSION_KEY = 'content_version';
/** `NOTIFY` channel telling api processes to re-read `settings.content_version`. */
export const CONTENT_CHANNEL = 'rc_content';
/** Content hash format (tools/content-build: first 12 hex chars of sha256). */
export const CONTENT_HASH = /^[0-9a-f]{12}$/;

/** Server-only part of a practice: the full manifest and its scripts (relpath → text). */
export interface ServerPractice {
  manifest: PracticeManifest;
  files: Record<string, string>;
}

export interface ContentStore {
  version: string;
  index: CourseIndex;
  catalog: Catalog;
  lesson(id: string): Lesson | undefined;
  task(id: string): Task | undefined;
  trackOfLesson(id: string): Track | undefined;
  practice(id: string): ServerPractice | undefined;
  /**
   * Tracks counted for ranks (spec §4.5): `status: complete` and every `kind: lesson` node
   * completed. Practices are not required.
   */
  completedTrackCount(completed: Set<string>): number;
}

/** `CONTENT_DIR/server/<hash>` — the only part of content-dist the api reads. */
export function serverDir(dir: string, hash: string): string {
  if (!CONTENT_HASH.test(hash)) throw new Error(`invalid content version "${hash}"`);
  return join(dir, 'server', hash);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

/** Every file under `root`, as posix relpath → absolute path. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

async function loadPractices(root: string): Promise<Map<string, ServerPractice>> {
  const practices = new Map<string, ServerPractice>();
  let ids: string[];
  try {
    ids = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return practices;
    throw err;
  }
  for (const id of ids.sort()) {
    const dir = join(root, id);
    const files: Record<string, string> = {};
    let manifest: PracticeManifest | undefined;
    for (const rel of await listFiles(dir)) {
      if (rel === 'practice.json') manifest = await readJson<PracticeManifest>(join(dir, rel));
      else files[rel] = await readFile(join(dir, rel), 'utf8');
    }
    if (!manifest) throw new Error(`practice ${id}: practice.json is missing`);
    practices.set(id, { manifest, files });
  }
  return practices;
}

/** Reads `dir/server/<hash>/` (catalog, sections, practices) into memory. */
export async function loadContentStore(dir: string, hash: string): Promise<ContentStore> {
  const root = serverDir(dir, hash);
  const catalog = await readJson<Catalog>(join(root, 'catalog.json'));
  if (catalog.version !== hash) {
    throw new Error(`content ${hash}: catalog.json has version ${catalog.version}`);
  }
  const sections = new Map<string, Section>();
  const lessons = new Map<string, Lesson>();
  const tasks = new Map<string, Task>();
  const lessonTrack = new Map<string, Track>();
  for (const track of catalog.tracks) {
    for (const ref of track.sections) {
      const section = await readJson<Section>(join(root, 'sections', `${ref.id}.json`));
      sections.set(section.id, section);
      for (const lesson of section.lessons) {
        lessons.set(lesson.id, lesson);
        lessonTrack.set(lesson.id, track);
        for (const task of lesson.tasks) tasks.set(task.id, task);
      }
    }
  }
  const practices = await loadPractices(join(root, 'practices'));

  return {
    version: hash,
    catalog,
    index: { tracks: catalog.tracks, sections },
    lesson: (id) => lessons.get(id),
    task: (id) => tasks.get(id),
    trackOfLesson: (id) => lessonTrack.get(id),
    practice: (id) => practices.get(id),
    completedTrackCount: (completed) =>
      catalog.tracks.filter((t) => t.status === 'complete' && isTrackComplete(t, completed)).length,
  };
}

/** Holds the active `ContentStore` of this api process. */
export interface ContentHolder {
  /** The active content; `503` when no version is active or it could not be loaded. */
  current(): ContentStore;
  /** The active content, or null (for callers that work without content, e.g. `GET /api/me`). */
  peek(): ContentStore | null;
  /** Re-reads `settings.content_version` and loads that version if it changed. */
  reload(): Promise<void>;
  /** Stops listening for `NOTIFY rc_content`. */
  close(): Promise<void>;
}

/** A holder that never has content (no `CONTENT_DIR`). */
export const NO_CONTENT: ContentHolder = {
  current() {
    throw new HttpError(503, 'internal', 'course content is not available');
  },
  peek: () => null,
  reload: async () => {},
  close: async () => {},
};

export interface ContentHolderOptions {
  db: Db;
  /** content-dist root holding `server/<hash>/`. */
  dir: string;
  log?: Pick<FastifyBaseLogger, 'info' | 'error'>;
}

/**
 * Loads the active version and keeps it current: `LISTEN rc_content` reloads on every
 * `NOTIFY` and on every (re)connect of the listening connection, so a notification missed
 * while disconnected is caught up. Reloads run one at a time. A version that fails to load
 * is logged and the previous one stays active; with none, content routes answer 503.
 */
export async function startContentHolder(opts: ContentHolderOptions): Promise<ContentHolder> {
  const { db, dir, log } = opts;
  let store: ContentStore | null = null;
  let chain: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    const hash = await getSetting<string | null>(db, CONTENT_VERSION_KEY, null);
    if (hash === null) {
      store = null;
      return;
    }
    if (store?.version === hash) return;
    try {
      store = await loadContentStore(dir, hash);
      log?.info(`content version ${hash} loaded`);
    } catch (err) {
      log?.error(`content version ${hash} failed to load: ${(err as Error).message}`);
    }
  }

  const reload = () => {
    chain = chain.then(load, load);
    return chain;
  };

  const reloadInBackground = () => {
    reload().catch((err: unknown) => {
      log?.error(`content reload failed: ${(err as Error).message}`);
    });
  };
  const sub = await db.$client.listen(CONTENT_CHANNEL, reloadInBackground, reloadInBackground);
  await reload();

  return {
    current() {
      if (!store) throw new HttpError(503, 'internal', 'course content is not available');
      return store;
    },
    peek: () => store,
    reload,
    close: () => sub.unlisten(),
  };
}
