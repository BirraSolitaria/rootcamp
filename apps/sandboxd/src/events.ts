import type { ContainerEvent, SandboxDriver } from './driver/types.js';
import type { Lifecycle } from './lifecycle.js';

/** Pause before reconnecting a broken event stream. */
export const EVENTS_RETRY_MS = 1000;
/** An `oom` event marks its container for this long; the `die` that follows is then `oom`. */
const OOM_MEMORY_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Log = { warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void };
const silent: Log = { warn() {}, error() {} };

export interface WatchEventsDeps {
  driver: Pick<SandboxDriver, 'watchEvents' | 'containerState'>;
  lifecycle: Pick<Lifecycle, 'failSandbox'>;
  log?: Log;
  now?: () => number;
  retryMs?: number;
}

export interface EventWatcher {
  /** Settles after the first connection attempt (success or not; failures are retried). */
  ready: Promise<void>;
  /** Resolves once every event received so far has been handled (tests). */
  idle(): Promise<void>;
  stop(): void;
}

/**
 * Follows `docker events` for labelled containers (spec §6.6): a `die` of a `ready` sandbox's
 * container → `failed` with `oom` (an `oom` event came first, or the container is
 * `OOMKilled`) or `crashed`. `Lifecycle.failSandbox` sends `closed: sandbox_failed` on the
 * shared bus, books the minutes and removes the container. Our own stops are not affected: the
 * row leaves `ready` before its container is stopped. A broken stream is reopened from the last
 * event's time, so a dockerd restart loses nothing (the GC's dead-container check is the
 * backstop).
 */
export function watchEvents(deps: WatchEventsDeps): EventWatcher {
  const log = deps.log ?? silent;
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? EVENTS_RETRY_MS;
  const oomAt = new Map<string, number>();
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let retry: NodeJS.Timeout | undefined;
  let sinceMs: number | undefined;
  let chain: Promise<void> = Promise.resolve();

  async function handle(e: ContainerEvent): Promise<void> {
    const t = now();
    for (const [cid, at] of oomAt) if (t - at > OOM_MEMORY_MS) oomAt.delete(cid);
    if (e.action === 'oom') {
      oomAt.set(e.containerId, t);
      return;
    }
    if (!UUID_RE.test(e.sandboxId)) return;
    let oom = oomAt.has(e.containerId);
    if (!oom) {
      const st = await deps.driver.containerState(e.containerId).catch(() => null);
      oom = st?.oomKilled === true;
    }
    oomAt.delete(e.containerId);
    await deps.lifecycle.failSandbox(
      e.sandboxId,
      oom ? 'oom' : 'crashed',
      `the sandbox container exited (code ${e.exitCode ?? 'unknown'}${oom ? ', out of memory' : ''})`,
      { from: ['ready'], containerId: e.containerId },
    );
  }

  function onEvent(e: ContainerEvent): void {
    sinceMs = Math.max(sinceMs ?? 0, e.timeMs);
    chain = chain
      .then(() => handle(e))
      .catch((err: unknown) => log.error({ err, event: e }, 'docker event handling failed'));
  }

  function scheduleRetry(err?: unknown): void {
    unsubscribe = undefined;
    if (stopped) return;
    log.warn({ err }, 'docker event stream ended, reconnecting');
    retry = setTimeout(() => void connect(), retryMs);
    retry.unref();
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const from = sinceMs ?? now();
    try {
      const off = await deps.driver.watchEvents({ sinceMs: from, onEvent, onEnd: scheduleRetry });
      sinceMs ??= from;
      if (stopped) off();
      else unsubscribe = off;
    } catch (err) {
      scheduleRetry(err);
    }
  }

  return {
    ready: connect(),
    idle: async () => {
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
      } while (seen !== chain);
    },
    stop: () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
