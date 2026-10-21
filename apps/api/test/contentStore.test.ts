// Filesystem-only tests of loadContentStore (no Docker needed).
import { rm } from 'node:fs/promises';
import { trackLessonIds } from '@rootcamp/logic';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContentStore, serverDir } from '../src/services/contentStore.js';
import { buildCourse, MINI_CONTENT, tempContentDir } from './course.js';

const dir = tempContentDir();
let repoHash: string;
let miniHash: string;

beforeAll(async () => {
  repoHash = await buildCourse(dir);
  miniHash = await buildCourse(dir, MINI_CONTENT);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadContentStore', () => {
  it('loads catalog, sections, lessons and tasks of the repo course', async () => {
    const store = await loadContentStore(dir, repoHash);
    expect(store.version).toBe(repoHash);
    expect(store.catalog.version).toBe(repoHash);
    const t7 = store.catalog.tracks.find((t) => t.id === 't7')!;
    expect(trackLessonIds(t7)).toHaveLength(50);
    const firstLesson = trackLessonIds(t7)[0]!;
    const lesson = store.lesson(firstLesson)!;
    expect(lesson.id).toBe(firstLesson);
    expect(store.trackOfLesson(firstLesson)?.id).toBe('t7');
    expect(store.task(lesson.tasks[0]!.id)).toEqual(lesson.tasks[0]);
    expect(store.index.sections.size).toBe(
      store.catalog.tracks.reduce((n, t) => n + t.sections.length, 0),
    );
    expect(store.lesson('t7.s99.l99')).toBeUndefined();
    expect(store.task('nope')).toBeUndefined();
  });

  it('counts only complete tracks with every lesson done', async () => {
    const store = await loadContentStore(dir, repoHash);
    const t7 = store.catalog.tracks.find((t) => t.id === 't7')!;
    const t1 = store.catalog.tracks.find((t) => t.id === 't1')!;
    const all7 = trackLessonIds(t7);
    expect(store.completedTrackCount(new Set())).toBe(0);
    expect(store.completedTrackCount(new Set(all7.slice(1)))).toBe(0);
    expect(store.completedTrackCount(new Set(all7))).toBe(1);
    // t1 is `partial`: never counted, even when all its lessons are done.
    expect(t1.status).toBe('partial');
    expect(store.completedTrackCount(new Set([...all7, ...trackLessonIds(t1)]))).toBe(1);
  });

  it('loads server practices with their scripts', async () => {
    const store = await loadContentStore(dir, miniHash);
    const practice = store.practice('inc-demo')!;
    expect(practice.manifest.id).toBe('inc-demo');
    expect(Object.keys(practice.files)).toContain('check/file-created.sh');
    expect(store.practice('inc-missing')).toBeUndefined();
  });

  it('rejects malformed and missing versions', async () => {
    expect(() => serverDir(dir, '../public/x')).toThrow(/invalid content version/);
    await expect(loadContentStore(dir, 'abcdef012345')).rejects.toThrow();
  });
});
