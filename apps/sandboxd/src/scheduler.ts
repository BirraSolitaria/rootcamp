import type { SandboxClass } from '@rootcamp/api-contract';

/**
 * Sandbox admission scheduler (spec §6.5). Pure: no I/O, time comes in as `now`.
 * The lifecycle loop (every 2 s and on "a sandbox freed up") feeds it rows from
 * `sandboxes` and applies the result: `admit` → `starting`, `timeout` → `queue_timeout`,
 * `positions` → what `GET /api/runs/:id` reports.
 */

/** A row in state `queued`. */
export interface QueuedRow {
  id: string;
  class: SandboxClass;
  cpu: number;
  memMb: number;
  /** `queued_at`, ms since epoch. */
  queuedAt: number;
  /** Test sandbox (`practice:test`): outside the queue and the budget, at most one at a time. */
  test: boolean;
}

/** A row that holds resources (`starting` … `ready`, i.e. admitted and not yet stopped). */
export interface ActiveRow {
  class: SandboxClass;
  cpu: number;
  memMb: number;
  /**
   * True for a test sandbox: it reserves no budget, but while one is active no further
   * test row is admitted. Absent means false.
   */
  test?: boolean;
}

export interface Budget {
  memMb: number;
  cpu: number;
  heavySlots: number;
}

export interface PlanInput {
  queued: QueuedRow[];
  active: ActiveRow[];
  now: number;
  diskFreeGb: number;
  budget: Budget;
  /** `settings.sandboxes_drained`: no admissions at all (active sandboxes live out). */
  drained: boolean;
}

export interface Plan {
  /** Ids to move to `starting`, in admission order. */
  admit: string[];
  /** Ids to move to `queue_timeout`. */
  timeout: string[];
  /** 1-based queue position of every non-test row still `queued` after this plan. */
  positions: Record<string, number>;
}

/** §6.5 item 4: a request that has waited this long gets `queue_timeout` (boundary inclusive). */
export const QUEUE_TIMEOUT_MS = 20 * 60_000;
/** §6.5 item 3: a heavy waiting longer than this (strictly) blocks the requests behind it. */
export const HEAVY_STARVATION_MS = 10 * 60_000;
/** §6.5 item 2: admissions need at least this much free disk (boundary inclusive). */
export const MIN_DISK_FREE_GB = 10;
/** §6.5 item 5. */
export const QUEUE_MAX = 10;

/** Absorbs float error in CPU sums (e.g. seven × 0.5 against 3.5). */
const EPS = 1e-9;

const fifo = (x: QueuedRow, y: QueuedRow): number =>
  x.queuedAt - y.queuedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

export function plan(i: PlanInput): Plan {
  const admit: string[] = [];
  const timeout: string[] = [];
  const waiting: QueuedRow[] = [];
  const tests: QueuedRow[] = [];

  // §6.5 item 1 + 4: FIFO order; drop timed-out rows first, whatever the resources.
  for (const r of [...i.queued].sort(fifo)) {
    if (i.now - r.queuedAt >= QUEUE_TIMEOUT_MS) timeout.push(r.id);
    else if (r.test) tests.push(r);
    else waiting.push(r);
  }

  const canStart = !i.drained && i.diskFreeGb >= MIN_DISK_FREE_GB;
  const stillQueued: QueuedRow[] = [];

  if (canStart) {
    let mem = 0;
    let cpu = 0;
    let heavy = 0;
    let testActive = false;
    for (const s of i.active) {
      if (s.test) {
        testActive = true;
        continue;
      }
      mem += s.memMb;
      cpu += s.cpu;
      if (s.class === 'heavy') heavy++;
    }

    // Test rows: no budget, at most one test sandbox active or admitted at a time.
    const t = tests[0];
    if (!testActive && t) admit.push(t.id);

    // §6.5 item 2 + 3.
    let blocked = false;
    for (const r of waiting) {
      if (blocked) {
        stillQueued.push(r);
        continue;
      }
      const isHeavy = r.class === 'heavy';
      const fits =
        mem + r.memMb <= i.budget.memMb + EPS &&
        cpu + r.cpu <= i.budget.cpu + EPS &&
        (!isHeavy || heavy < i.budget.heavySlots);
      if (fits) {
        admit.push(r.id);
        mem += r.memMb;
        cpu += r.cpu;
        if (isHeavy) heavy++;
      } else {
        stillQueued.push(r);
        // A starving heavy that cannot start holds back everything behind it.
        if (isHeavy && i.now - r.queuedAt > HEAVY_STARVATION_MS) blocked = true;
      }
    }
  } else {
    stillQueued.push(...waiting);
  }

  const positions: Record<string, number> = {};
  stillQueued.forEach((r, n) => (positions[r.id] = n + 1));
  return { admit, timeout, positions };
}

/** §6.5 item 5 + drain mode: may a new request join the queue? */
export function canEnqueue(
  queuedCount: number,
  drained: boolean,
  max: number = QUEUE_MAX,
): 'ok' | 'queue_full' {
  return drained || queuedCount >= max ? 'queue_full' : 'ok';
}
