import { describe, expect, test } from 'vitest';
import type { SandboxClass } from '@rootcamp/api-contract';
import {
  canEnqueue,
  HEAVY_STARVATION_MS,
  MIN_DISK_FREE_GB,
  plan,
  QUEUE_TIMEOUT_MS,
  type ActiveRow,
  type Budget,
  type PlanInput,
  type QueuedRow,
} from '../src/scheduler.js';
import { CLASS_LIMITS } from '../src/driver/types.js';

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const FULL: Budget = { memMb: 5120, cpu: 3.5, heavySlots: 1 };
const ONE_LIGHT: Budget = { memMb: 512, cpu: 0.5, heavySlots: 1 };

function q(id: string, cls: SandboxClass, waitedMs: number, testRow = false): QueuedRow {
  const { cpu, memMb } = CLASS_LIMITS[cls];
  return { id, class: cls, cpu, memMb, queuedAt: NOW - waitedMs, test: testRow };
}

function a(cls: SandboxClass, testRow?: boolean): ActiveRow {
  const { cpu, memMb } = CLASS_LIMITS[cls];
  return testRow === undefined
    ? { class: cls, cpu, memMb }
    : { class: cls, cpu, memMb, test: testRow };
}

function run(p: Partial<PlanInput>) {
  return plan({
    queued: [],
    active: [],
    now: NOW,
    diskFreeGb: 50,
    budget: FULL,
    drained: false,
    ...p,
  });
}

describe('plan — brief cases', () => {
  test('one light slot: two lights → first admitted, second at position 1', () => {
    const r = run({ budget: ONE_LIGHT, queued: [q('a', 'light', 2 * MIN), q('b', 'light', MIN)] });
    expect(r).toEqual({ admit: ['a'], timeout: [], positions: { b: 1 } });
  });

  test('after the slot frees up the second is admitted', () => {
    const r = run({ budget: ONE_LIGHT, queued: [q('b', 'light', MIN)], active: [] });
    expect(r).toEqual({ admit: ['b'], timeout: [], positions: {} });
    // and while the first is still active it is not
    const busy = run({ budget: ONE_LIGHT, queued: [q('b', 'light', MIN)], active: [a('light')] });
    expect(busy).toEqual({ admit: [], timeout: [], positions: { b: 1 } });
  });

  test('heavy is not admitted while the heavy slot is taken', () => {
    const r = run({ queued: [q('h', 'heavy', MIN)], active: [a('heavy')] });
    expect(r).toEqual({ admit: [], timeout: [], positions: { h: 1 } });
  });

  test('heavy waiting 11 min blocks a light behind it despite free resources', () => {
    const r = run({
      queued: [q('h', 'heavy', 11 * MIN), q('l', 'light', MIN)],
      active: [a('heavy')],
    });
    expect(r).toEqual({ admit: [], timeout: [], positions: { h: 1, l: 2 } });
  });

  test('a request older than 20 min times out', () => {
    const r = run({ queued: [q('old', 'light', 21 * MIN), q('new', 'light', MIN)] });
    expect(r).toEqual({ admit: ['new'], timeout: ['old'], positions: {} });
  });

  test('diskFreeGb 9 → nothing admitted', () => {
    const r = run({ diskFreeGb: 9, queued: [q('a', 'light', MIN), q('t', 'light', MIN, true)] });
    expect(r).toEqual({ admit: [], timeout: [], positions: { a: 1 } });
  });

  test('canEnqueue', () => {
    expect(canEnqueue(10, false)).toBe('queue_full');
    expect(canEnqueue(0, true)).toBe('queue_full');
    expect(canEnqueue(9, false)).toBe('ok');
    expect(canEnqueue(0, false)).toBe('ok');
    expect(canEnqueue(11, false)).toBe('queue_full');
    expect(canEnqueue(3, false, 3)).toBe('queue_full');
  });
});

describe('plan — budget', () => {
  test('exact fit of the full budget is admitted (0.5+1+2 CPU = 3.5, 512+1536+2560 MB ≤ 5120)', () => {
    const r = run({
      queued: [q('l', 'light', 3 * MIN), q('d', 'docker', 2 * MIN), q('h', 'heavy', MIN)],
    });
    expect(r.admit).toEqual(['l', 'd', 'h']);
  });

  test('exact memory fit with a 1-MB overflow is rejected', () => {
    const budget = { memMb: 1024, cpu: 10, heavySlots: 1 };
    expect(run({ budget, queued: [q('a', 'light', 2 * MIN), q('b', 'light', MIN)] }).admit).toEqual(
      ['a', 'b'],
    );
    const tight = { ...budget, memMb: 1023 };
    expect(
      run({ budget: tight, queued: [q('a', 'light', 2 * MIN), q('b', 'light', MIN)] }),
    ).toEqual({
      admit: ['a'],
      timeout: [],
      positions: { b: 1 },
    });
  });

  test('seven lights fill 3.5 CPU exactly; the eighth waits (float sums)', () => {
    const queued = Array.from({ length: 8 }, (_, i) => q(`l${i}`, 'light', (10 - i) * MIN));
    const r = run({ budget: { memMb: 99_999, cpu: 3.5, heavySlots: 1 }, queued });
    expect(r.admit).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
    expect(r.positions).toEqual({ l7: 1 });
  });

  test('active rows reserve resources', () => {
    // memory-bound: 3 × 1536 = 4608 MB active; another docker (1536) does not fit, a light (512) does
    const r = run({
      active: [a('docker'), a('docker'), a('docker')],
      queued: [q('d', 'docker', 2 * MIN), q('l', 'light', MIN)],
    });
    expect(r).toEqual({ admit: ['l'], timeout: [], positions: { d: 1 } });
  });

  test('CPU-bound: 3.0 active, docker (1.0) does not fit, light (0.5) fits exactly', () => {
    const r = run({
      budget: { memMb: 99_999, cpu: 3.5, heavySlots: 1 },
      active: [a('heavy'), a('docker')],
      queued: [q('d', 'docker', 2 * MIN), q('l', 'light', MIN)],
    });
    expect(r).toEqual({ admit: ['l'], timeout: [], positions: { d: 1 } });
  });

  test('a later smaller request may pass one that does not fit (no starvation guard for non-heavy)', () => {
    const r = run({
      active: [a('heavy'), a('docker')],
      queued: [q('d', 'docker', 15 * MIN), q('l', 'light', MIN)],
    });
    expect(r).toEqual({ admit: ['l'], timeout: [], positions: { d: 1 } });
  });

  test('only one heavy per tick when a single slot is free', () => {
    const r = run({ queued: [q('h1', 'heavy', 2 * MIN), q('h2', 'heavy', MIN)] });
    expect(r).toEqual({ admit: ['h1'], timeout: [], positions: { h2: 1 } });
  });

  test('heavySlots 0 never admits heavy', () => {
    const r = run({ budget: { ...FULL, heavySlots: 0 }, queued: [q('h', 'heavy', MIN)] });
    expect(r.admit).toEqual([]);
  });

  test('ordering is FIFO by queuedAt regardless of input order, ties by id', () => {
    const r = run({
      budget: ONE_LIGHT,
      queued: [q('c', 'light', MIN), q('b', 'light', 5 * MIN), q('a', 'light', 5 * MIN)],
    });
    expect(r).toEqual({ admit: ['a'], timeout: [], positions: { b: 1, c: 2 } });
  });
});

describe('plan — disk', () => {
  test('exactly 10 GB free allows admission', () => {
    expect(MIN_DISK_FREE_GB).toBe(10);
    expect(run({ diskFreeGb: 10, queued: [q('a', 'light', MIN)] }).admit).toEqual(['a']);
  });

  test('9.99 GB free blocks admission but timeouts still happen', () => {
    const r = run({
      diskFreeGb: 9.99,
      queued: [q('old', 'light', 25 * MIN), q('a', 'light', MIN)],
    });
    expect(r).toEqual({ admit: [], timeout: ['old'], positions: { a: 1 } });
  });
});

describe('plan — timeouts', () => {
  test('exactly 20 min waited → timeout; one ms less → still queued', () => {
    expect(QUEUE_TIMEOUT_MS).toBe(20 * MIN);
    const r = run({
      budget: { memMb: 0, cpu: 0, heavySlots: 0 },
      queued: [q('at', 'light', 20 * MIN), q('below', 'light', 20 * MIN - 1)],
    });
    expect(r).toEqual({ admit: [], timeout: ['at'], positions: { below: 1 } });
  });

  test('timed-out rows free their position', () => {
    const r = run({
      budget: { memMb: 0, cpu: 0, heavySlots: 0 },
      queued: [q('x', 'light', 30 * MIN), q('y', 'light', 5 * MIN), q('z', 'docker', MIN)],
    });
    expect(r).toEqual({ admit: [], timeout: ['x'], positions: { y: 1, z: 2 } });
  });

  test('a timed-out heavy does not hold the starvation barrier', () => {
    const r = run({
      active: [a('heavy')],
      queued: [q('h', 'heavy', 20 * MIN), q('l', 'light', MIN)],
    });
    expect(r).toEqual({ admit: ['l'], timeout: ['h'], positions: {} });
  });

  test('test rows time out too', () => {
    const r = run({ active: [a('light', true)], queued: [q('t', 'light', 20 * MIN, true)] });
    expect(r).toEqual({ admit: [], timeout: ['t'], positions: {} });
  });
});

describe('plan — heavy anti-starvation', () => {
  test('exactly 10 min waited does not block; 10 min + 1 ms does', () => {
    expect(HEAVY_STARVATION_MS).toBe(10 * MIN);
    const at = run({
      active: [a('heavy')],
      queued: [q('h', 'heavy', 10 * MIN), q('l', 'light', MIN)],
    });
    expect(at).toEqual({ admit: ['l'], timeout: [], positions: { h: 1 } });
    const over = run({
      active: [a('heavy')],
      queued: [q('h', 'heavy', 10 * MIN + 1), q('l', 'light', MIN)],
    });
    expect(over).toEqual({ admit: [], timeout: [], positions: { h: 1, l: 2 } });
  });

  test('a starving heavy that fits is admitted and the rest continue', () => {
    const r = run({
      queued: [q('h', 'heavy', 12 * MIN), q('d', 'docker', 2 * MIN), q('l', 'light', MIN)],
    });
    expect(r.admit).toEqual(['h', 'd', 'l']);
  });

  test('a starving heavy blocked by memory (not the slot) also blocks the rest', () => {
    // heavy slot free, but 3 dockers hold 4608 MB → heavy (2560) does not fit; light (512) would
    const r = run({
      active: [a('docker'), a('docker'), a('docker')],
      queued: [q('h', 'heavy', 11 * MIN), q('l', 'light', MIN)],
    });
    expect(r).toEqual({ admit: [], timeout: [], positions: { h: 1, l: 2 } });
  });

  test('rows ahead of the starving heavy are still considered', () => {
    const r = run({
      active: [a('heavy')],
      queued: [q('l1', 'light', 15 * MIN), q('h', 'heavy', 11 * MIN), q('l2', 'light', MIN)],
    });
    expect(r).toEqual({ admit: ['l1'], timeout: [], positions: { h: 1, l2: 2 } });
  });

  test('the starvation barrier does not block test rows', () => {
    const r = run({
      active: [a('heavy')],
      queued: [q('h', 'heavy', 11 * MIN), q('t', 'light', MIN, true)],
    });
    expect(r).toEqual({ admit: ['t'], timeout: [], positions: { h: 1 } });
  });
});

describe('plan — drained', () => {
  test('drained admits no user rows but still admits a test row (§11.5 practice:test --all)', () => {
    const r = run({
      drained: true,
      queued: [q('old', 'light', 21 * MIN), q('a', 'light', MIN), q('t', 'light', MIN, true)],
    });
    expect(r).toEqual({ admit: ['t'], timeout: ['old'], positions: { a: 1 } });
  });

  test('drained: an active test still blocks the next test row', () => {
    const r = run({
      drained: true,
      active: [a('light', true)],
      queued: [q('t', 'light', MIN, true)],
    });
    expect(r).toEqual({ admit: [], timeout: [], positions: {} });
  });

  test('drained + low disk: the test row is not admitted either', () => {
    const r = run({ drained: true, diskFreeGb: 9, queued: [q('t', 'light', MIN, true)] });
    expect(r).toEqual({ admit: [], timeout: [], positions: {} });
  });
});

describe('plan — test rows', () => {
  test('a test row bypasses the budget and gets no position', () => {
    const r = run({
      budget: { memMb: 0, cpu: 0, heavySlots: 0 },
      queued: [q('t', 'heavy', MIN, true), q('a', 'light', MIN)],
    });
    expect(r).toEqual({ admit: ['t'], timeout: [], positions: { a: 1 } });
  });

  test('a test row does not consume budget for user rows', () => {
    const r = run({
      budget: ONE_LIGHT,
      queued: [q('t', 'light', 2 * MIN, true), q('a', 'light', MIN)],
    });
    expect(r.admit).toEqual(['t', 'a']);
  });

  test('an active test sandbox does not reserve budget', () => {
    const r = run({
      budget: ONE_LIGHT,
      active: [a('heavy', true)],
      queued: [q('a', 'light', MIN)],
    });
    expect(r.admit).toEqual(['a']);
  });

  test('at most one test row is admitted per tick (earliest first)', () => {
    const r = run({ queued: [q('t2', 'light', MIN, true), q('t1', 'light', 2 * MIN, true)] });
    expect(r).toEqual({ admit: ['t1'], timeout: [], positions: {} });
  });

  test('no test row is admitted while a test sandbox is active', () => {
    const r = run({ active: [a('light', true)], queued: [q('t', 'light', MIN, true)] });
    expect(r).toEqual({ admit: [], timeout: [], positions: {} });
  });

  test('a non-test active row (test flag absent or false) does not block tests', () => {
    const r = run({
      active: [a('light'), a('light', false)],
      queued: [q('t', 'light', MIN, true)],
    });
    expect(r.admit).toEqual(['t']);
  });
});

describe('plan — misc', () => {
  test('empty input', () => {
    expect(run({})).toEqual({ admit: [], timeout: [], positions: {} });
  });

  test('does not mutate its input', () => {
    const queued = [q('b', 'light', MIN), q('a', 'light', 2 * MIN)];
    const snapshot = structuredClone(queued);
    run({ queued });
    expect(queued).toEqual(snapshot);
  });
});
