import { sandboxes, type Db } from '@rootcamp/db';
import { inArray } from 'drizzle-orm';
import type { SandboxDriver } from './driver/types.js';
import type { Lifecycle } from './lifecycle.js';

type Log = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
const silent: Log = { info() {}, warn() {} };

export interface ReconcileDeps {
  db: Db;
  driver: Pick<SandboxDriver, 'listManaged'>;
  lifecycle: Pick<Lifecycle, 'failSandbox' | 'completeStop' | 'startedAt'>;
  now?: () => number;
  log?: Log;
}

export interface ReconcileResult {
  /** `ready` rows whose container is running: picked up as they are. */
  adopted: string[];
  /** Rows marked `failed/lost`. */
  lost: string[];
  /** `stopping` rows whose stop was finished. */
  stopped: string[];
}

/**
 * Start-up reconciliation (spec §6.6), run before the scheduler loop starts. Compares the
 * labelled containers with the rows a previous process left behind:
 * - `ready` with its container running → adopted (the GC and the terminal take over);
 * - `ready` without a running container → `failed/lost`, `closed: sandbox_failed`, the minutes
 *   booked up to now but never past `expires_at`;
 * - `starting` → `failed/lost`: no process is bringing it up any more (its container goes);
 * - `stopping` → the stop is finished (container removed, `stopped`, minutes booked).
 * Containers without a row (or with a stopped / failed one) are left to the GC's first pass.
 */
export async function reconcileOnStart(deps: ReconcileDeps): Promise<ReconcileResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? silent;
  const result: ReconcileResult = { adopted: [], lost: [], stopped: [] };
  const rows = await deps.db
    .select({
      id: sandboxes.id,
      state: sandboxes.state,
      containerId: sandboxes.containerId,
      expiresAt: sandboxes.expiresAt,
    })
    .from(sandboxes)
    .where(inArray(sandboxes.state, ['starting', 'ready', 'stopping']));
  const running = new Set(
    (await deps.driver.listManaged()).filter((c) => c.running).map((c) => c.containerId),
  );

  for (const r of rows) {
    if (r.state === 'ready') {
      if (r.containerId && running.has(r.containerId)) {
        result.adopted.push(r.id);
        continue;
      }
      const t = now();
      const usageAt = new Date(r.expiresAt ? Math.min(t, r.expiresAt.getTime()) : t);
      if (
        await deps.lifecycle.failSandbox(
          r.id,
          'lost',
          'the sandbox container was gone when sandboxd started',
          { from: ['ready'], usageAt },
        )
      ) {
        result.lost.push(r.id);
      }
    } else if (r.state === 'starting') {
      if (deps.lifecycle.startedAt(r.id) !== undefined) continue; // this process owns it
      if (
        await deps.lifecycle.failSandbox(r.id, 'lost', 'sandboxd restarted while it was starting', {
          from: ['starting'],
        })
      ) {
        result.lost.push(r.id);
      }
    } else if (await deps.lifecycle.completeStop(r.id)) {
      result.stopped.push(r.id);
    }
  }
  log.info(
    { adopted: result.adopted.length, lost: result.lost.length, stopped: result.stopped.length },
    'reconciled sandboxes with containers',
  );
  return result;
}
