import { expect, test } from 'vitest';
import { formatMmSs, lastNDays, layerHash, weekdayLabel } from '../src/format.js';
import { normalize, normalizeKey } from '../src/index.js';
import { pluralDays } from '../src/plural.js';
import { shuffle } from '../src/shuffle.js';

test.each([
  [1, 'день'],
  [2, 'дня'],
  [5, 'дней'],
  [11, 'дней'],
  [12, 'дней'],
  [14, 'дней'],
  [21, 'день'],
  [22, 'дня'],
  [111, 'дней'],
  [0, 'дней'],
])('pluralDays(%i)', (n, w) => expect(pluralDays(n as number)).toBe(w));
test('formatMmSs', () => {
  expect(formatMmSs(1_800_000)).toBe('30:00');
  expect(formatMmSs(61_000)).toBe('01:01');
  expect(formatMmSs(500)).toBe('00:01');
  expect(formatMmSs(0)).toBe('00:00');
});
test('weekdayLabel', () => {
  expect(weekdayLabel('2026-10-18')).toBe('Вс');
  expect(weekdayLabel('2026-10-19')).toBe('Пн');
});
test('lastNDays', () =>
  expect(lastNDays('2026-10-02', 3)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']));
test('layerHash is a stable 6-hex FNV-1a digest', () => {
  // FNV-1a("") = 0x811c9dc5 → >>> 8 = 0x811c9d
  expect(layerHash('')).toBe('811c9d');
  // FNV-1a("a") = 0xe40c292c → >>> 8 = 0xe40c29
  expect(layerHash('a')).toBe('e40c29');
  expect(layerHash('t1.s01.l01')).toMatch(/^[0-9a-f]{6}$/);
  expect(layerHash('t1.s01.l01')).toBe(layerHash('t1.s01.l01'));
  expect(layerHash('t1.s01.l01')).not.toBe(layerHash('t1.s01.l02'));
});
test('normalize/normalizeKey are re-exported from @rootcamp/content-schema', () => {
  expect(normalize('  Docker   RUN ')).toBe('docker run');
  expect(normalizeKey('Что такое «образ»?')).toBe('что такое образ');
});
test('shuffle is deterministic with injected rng and does not mutate', () => {
  const src = [1, 2, 3, 4];
  const seq = [0.9, 0.1, 0.5];
  let i = 0;
  const out = shuffle(src, () => seq[i++ % seq.length]!);
  expect(src).toEqual([1, 2, 3, 4]);
  expect([...out].sort()).toEqual([1, 2, 3, 4]);
  // Fisher–Yates from the end: i=3 j=floor(0.9*4)=3; i=2 j=floor(0.1*3)=0 (swap); i=1 j=floor(0.5*2)=1
  expect(out).toEqual([3, 2, 1, 4]);
  expect(shuffle(src, () => 0.999)).toEqual(shuffle(src, () => 0.999));
  expect(shuffle(src, () => 0.999)).toEqual([1, 2, 3, 4]);
  expect(shuffle(src, () => 0)).toEqual([2, 3, 4, 1]);
});
