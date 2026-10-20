import { beforeEach, expect, test } from 'vitest';
import { trackLessonIds } from '../src/courseQuery.js';
import {
  currentLessonId,
  isTrackComplete,
  lessonStatuses,
  practiceAvailability,
} from '../src/unlock.js';
import { makeTrack } from './helpers/makeTrack.js';

beforeEach(() => {
  expect.hasAssertions();
});

const { track } = makeTrack({ sections: 2, lessonsPerSection: 4 });

test('empty progress → first current, rest locked', () => {
  const s = lessonStatuses(track, []);
  expect(s['t1.s01.l01']).toBe('current');
  expect(s['t1.s01.l02']).toBe('locked');
  expect(Object.keys(s)).toHaveLength(8);
  expect(Object.values(s).filter((v) => v === 'locked')).toHaveLength(7);
  expect(currentLessonId(track, [])).toBe('t1.s01.l01');
  expect(isTrackComplete(track, [])).toBe(false);
});

test('section finished → next section first lesson current', () =>
  expect(
    lessonStatuses(track, ['t1.s01.l01', 't1.s01.l02', 't1.s01.l03', 't1.s01.l04'])['t1.s02.l01'],
  ).toBe('current'));

test('hole in the middle becomes current', () => {
  const s = lessonStatuses(track, ['t1.s01.l01', 't1.s01.l03']);
  expect(s['t1.s01.l02']).toBe('current');
  expect(s['t1.s01.l03']).toBe('completed');
  expect(s['t1.s01.l04']).toBe('locked');
  expect(currentLessonId(track, ['t1.s01.l01', 't1.s01.l03'])).toBe('t1.s01.l02');
});

test('unknown completed ids ignored; track complete', () => {
  const all = trackLessonIds(track);
  expect(isTrackComplete(track, all.concat('zz'))).toBe(true);
  expect(currentLessonId(track, all)).toBeNull();
  expect(lessonStatuses(track, ['zz'])).not.toHaveProperty('zz');
  expect(isTrackComplete(track, ['zz'])).toBe(false);
});

test('completed accepts any iterable', () => {
  expect(currentLessonId(track, new Set(['t1.s01.l01']))).toBe('t1.s01.l02');
});

const mixed = makeTrack({ layout: [['L', 'L', 'inc-x00', 'inc-y00', 'L']] }).track;

test('practices locked until the preceding lesson is done; they never block lessons', () => {
  expect(practiceAvailability(mixed, [])).toEqual({ 'inc-x00': 'locked', 'inc-y00': 'locked' });
  expect(lessonStatuses(mixed, [])['t1.s01.l01']).toBe('current');

  const done = ['t1.s01.l01', 't1.s01.l02'];
  expect(practiceAvailability(mixed, done)).toEqual({
    'inc-x00': 'available',
    'inc-y00': 'available',
  });
  expect(lessonStatuses(mixed, done)).toEqual({
    't1.s01.l01': 'completed',
    't1.s01.l02': 'completed',
    't1.s01.l03': 'current',
  });
  expect(currentLessonId(mixed, done)).toBe('t1.s01.l03');
});

test('practice depends on the nearest preceding lesson only', () => {
  expect(practiceAvailability(mixed, ['t1.s01.l02'])).toEqual({
    'inc-x00': 'available',
    'inc-y00': 'available',
  });
  expect(practiceAvailability(mixed, ['t1.s01.l01'])).toEqual({
    'inc-x00': 'locked',
    'inc-y00': 'locked',
  });
});

test('practice looks back across sections; with no preceding lesson it is available', () => {
  const t = makeTrack({
    layout: [
      ['inc-first', 'L'],
      ['inc-next', 'L'],
    ],
  }).track;
  expect(practiceAvailability(t, [])).toEqual({ 'inc-first': 'available', 'inc-next': 'locked' });
  expect(practiceAvailability(t, ['t1.s01.l01'])).toEqual({
    'inc-first': 'available',
    'inc-next': 'available',
  });
});

test('isTrackComplete counts only kind lesson', () => {
  expect(isTrackComplete(mixed, ['t1.s01.l01', 't1.s01.l02', 't1.s01.l03'])).toBe(true);
  expect(
    isTrackComplete(mixed, ['t1.s01.l01', 't1.s01.l02', 't1.s01.p-inc-x00', 't1.s01.p-inc-y00']),
  ).toBe(false);
});
