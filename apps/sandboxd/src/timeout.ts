/** Default limit for a single driver / lifecycle call made by the GC or the metrics poller. */
export const CALL_TIMEOUT_MS = 20_000;

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish in ${ms} ms`);
  }
}

/**
 * Rejects with `TimeoutError` if `p` has not settled after `ms`. The underlying call is not
 * cancelled; the caller just stops waiting for it, so a hung dockerd call cannot wedge a loop.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    timer.unref();
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}
