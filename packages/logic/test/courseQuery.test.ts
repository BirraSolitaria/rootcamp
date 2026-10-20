import { beforeEach, expect, test } from 'vitest';
import { INTERACTIVE_TASK_TYPES } from '@rootcamp/content-schema';
import { allTaskIds, findLesson, findTask, tasksOfLessons, trackLessonIds } from '../src/courseQuery.js';
import { makeTrack } from './helpers/makeTrack.js';

beforeEach(() => {
  expect.hasAssertions();
});

test('course queries', () => {
  const { index: ix } = makeTrack({ sections: 2, lessonsPerSection: 4, tasksPerLesson: 10 });
  expect(findTask(ix, 't1.s02.l01.t03')?.id).toBe('t1.s02.l01.t03');
  expect(findTask(ix, 't1.s02.l01.t99')).toBeUndefined();
  expect(findLesson(ix, 't1.s02.l04')?.id).toBe('t1.s02.l04');
  expect(findLesson(ix, 't1.s09.l01')).toBeUndefined();
  expect(tasksOfLessons(ix, ['t1.s01.l02', 'nope'])).toHaveLength(10);
  expect(allTaskIds(ix).size).toBe(80);
});

test('tasksOfLessons keeps the given order', () => {
  const { index: ix } = makeTrack({ tasksPerLesson: 2 });
  expect(tasksOfLessons(ix, ['t1.s02.l01', 't1.s01.l01']).map((t) => t.id)).toEqual([
    't1.s02.l01.t01',
    't1.s02.l01.t02',
    't1.s01.l01.t01',
    't1.s01.l01.t02',
  ]);
});

test('tasksOfLessons excludes terminal_practice tasks', () => {
  const { index: ix } = makeTrack({ layout: [['L', 'inc-xyz', 'L']], tasksPerLesson: 3 });
  const tasks = tasksOfLessons(ix, ['t1.s01.l01', 't1.s01.p-inc-xyz', 't1.s01.l02']);
  expect(tasks).toHaveLength(6);
  expect(tasks.some((t) => t.type === 'terminal_practice')).toBe(false);
  expect(findTask(ix, 't1.s01.p-inc-xyz.t01')?.type).toBe('terminal_practice');
  expect(findLesson(ix, 't1.s01.p-inc-xyz')?.kind).toBe('practice');
});

test('trackLessonIds: only kind lesson, in path order', () => {
  const { track } = makeTrack({ layout: [['L', 'L', 'inc-xxx', 'L'], ['inc-yyy', 'L']] });
  expect(trackLessonIds(track)).toEqual(['t1.s01.l01', 't1.s01.l02', 't1.s01.l03', 't1.s02.l01']);
});

test('findLesson ignores sections missing from the index', () => {
  const { track } = makeTrack();
  expect(findLesson({ tracks: [track], sections: new Map() }, 't1.s01.l01')).toBeUndefined();
});

test('makeTrack defaults and shape', () => {
  const { track, index } = makeTrack();
  expect(track.id).toBe('t1');
  expect(track.sections.map((s) => s.id)).toEqual(['t1.s01', 't1.s02']);
  expect(trackLessonIds(track)).toHaveLength(8);
  expect(allTaskIds(index).size).toBe(48);
  const lesson = findLesson(index, 't1.s01.l01');
  expect(lesson?.tasks.map((t) => t.type)).toEqual([...INTERACTIVE_TASK_TYPES]);
  for (const t of tasksOfLessons(index, trackLessonIds(track))) {
    if (t.type === 'terminal_practice') continue;
    expect(t.explanation).toContain(t.id);
    expect(t.explanation).toMatch(/[а-яё]/i);
  }
});
