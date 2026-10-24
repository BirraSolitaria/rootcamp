import type { CheckResponse, RunDto, ServerCtl } from '@rootcamp/api-contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../../api/client';
import {
  PRACTICES_KEY,
  isActive,
  practiceApi,
  readStoredRun,
  runKey,
  storeRun,
  useRun,
} from '../../api/practice';
import { ME_KEY } from '../../api/queries';
import { PROGRESS_KEY } from '../../content/useContent';
import { practiceErrorText } from './messages';

/**
 * The run of one practice screen: which run it shows, its polled state and every action on it.
 *
 * - The run id survives a reload (and reaches a second tab) through localStorage. A stored run
 *   that is already over when the screen opens is dropped: the screen starts from the brief.
 *   A run that ends while the screen watches it stays, so its end («Время вышло»…) is shown.
 * - «Начать» sends one POST at a time (a ref guards it before React re-renders); a
 *   `409 run_exists` adopts the run named in the error.
 * - Mutations take the run id as their variables, so errors of an older run are not shown.
 */
export function useIncident(practiceId: string) {
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(() => readStoredRun(practiceId));
  /** The run seen in queued / starting / ready (or created) by this screen. */
  const [watched, setWatched] = useState<string | null>(null);
  const run = useRun(runId);
  const data = runId !== null ? run.data : undefined;

  const adopt = useCallback(
    (id: string | null) => {
      setRunId(id);
      storeRun(practiceId, id);
    },
    [practiceId],
  );

  useEffect(() => {
    if (runId === null) return;
    if (run.error instanceof ApiClientError && run.error.status === 404) {
      adopt(null);
      return;
    }
    if (!data) return;
    if (data.practiceId !== practiceId) {
      // Another practice's run (from `run_exists`): remembered there, not here.
      storeRun(practiceId, null);
      if (isActive(data.state)) storeRun(data.practiceId, runId);
      return;
    }
    if (isActive(data.state)) {
      if (watched !== runId) setWatched(runId);
    } else if (watched !== runId) {
      adopt(null);
    }
  }, [runId, data, run.error, watched, practiceId, adopt]);

  const setRun = useCallback(
    (patch: (r: RunDto) => RunDto) => {
      if (runId) qc.setQueryData<RunDto>(runKey(runId), (r) => (r ? patch(r) : r));
    },
    [qc, runId],
  );
  const refetchRun = useCallback(() => {
    if (runId) void qc.invalidateQueries({ queryKey: runKey(runId) });
  }, [qc, runId]);

  // «Начать» / «Новый сервер»
  const inFlight = useRef(false);
  const start = useMutation({
    mutationFn: () => practiceApi.createRun(practiceId),
    onSuccess: (res) => {
      setWatched(res.runId);
      adopt(res.runId);
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.code === 'run_exists' && err.runId) {
        setWatched(err.runId);
        adopt(err.runId);
      }
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const startRun = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    start.mutate();
  }, [start]);
  const startAdopted =
    start.error instanceof ApiClientError && start.error.code === 'run_exists' && start.error.runId;
  const startError = start.error && !startAdopted ? practiceErrorText(start.error) : null;

  // «Проверить»: the marks of the last check of this sandbox (a reset starts over).
  const sandboxKey = data ? `${data.runId}:${data.resetsLeft}` : null;
  const [lastCheck, setLastCheck] = useState<{ key: string; res: CheckResponse } | null>(null);
  const check = useMutation({
    mutationFn: (id: string) => practiceApi.check(id),
    onSuccess: (res, id) => {
      const cur = qc.getQueryData<RunDto>(runKey(id));
      if (cur) setLastCheck({ key: `${id}:${cur.resetsLeft}`, res });
      const passed = new Map(res.goals.map((g) => [g.id, g.passed]));
      qc.setQueryData<RunDto>(runKey(id), (r) =>
        r
          ? {
              ...r,
              state: res.solved ? 'solved' : r.state,
              goals: r.goals.map((g) => ({ ...g, passed: g.passed || !!passed.get(g.id) })),
            }
          : r,
      );
      if (res.solved || res.xpAwarded > 0) {
        void qc.invalidateQueries({ queryKey: ME_KEY });
        void qc.invalidateQueries({ queryKey: PROGRESS_KEY });
        void qc.invalidateQueries({ queryKey: PRACTICES_KEY });
      }
    },
  });
  const checkRes = lastCheck && lastCheck.key === sandboxKey ? lastCheck.res : null;

  const hint = useMutation({
    mutationFn: (id: string) => practiceApi.hint(id),
    onSuccess: (res, id) => {
      qc.setQueryData<RunDto>(runKey(id), (r) => {
        if (!r) return r;
        const hints = [...r.hints];
        hints[res.index] = res.text;
        return { ...r, hints, hintsRevealed: res.hintsRevealed };
      });
    },
  });

  const extend = useMutation({
    mutationFn: (id: string) => practiceApi.extend(id),
    onSuccess: (res, id) => {
      qc.setQueryData<RunDto>(runKey(id), (r) =>
        r ? { ...r, expiresAt: res.expiresAt, canExtend: false } : r,
      );
      void qc.invalidateQueries({ queryKey: runKey(id) });
    },
  });

  const reset = useMutation({
    mutationFn: (id: string) => practiceApi.reset(id),
    onSuccess: (_res, id) => {
      qc.setQueryData<RunDto>(runKey(id), (r) =>
        r ? { ...r, state: 'starting', usage: null, resetsLeft: Math.max(0, r.resetsLeft - 1) } : r,
      );
      void qc.invalidateQueries({ queryKey: runKey(id) });
    },
  });

  const stop = useMutation({
    mutationFn: (id: string) => practiceApi.stop(id),
    onSuccess: (_res, id) => {
      qc.setQueryData<RunDto>(runKey(id), (r) =>
        r && r.state !== 'solved'
          ? { ...r, state: 'stopped', stopReason: 'stopped_by_user', usage: null }
          : r,
      );
      void qc.invalidateQueries({ queryKey: runKey(id) });
    },
  });

  /** Frames of the terminal socket that change the run. */
  const onCtl = useCallback(
    (ctl: ServerCtl) => {
      if (ctl.t === 'extended') setRun((r) => ({ ...r, expiresAt: ctl.expiresAt }));
      // `reset` is our own «Сбросить сервер»: its answer already moved the run on.
      else if (ctl.t === 'expiring' || (ctl.t === 'closed' && ctl.reason !== 'reset')) refetchRun();
    },
    [setRun, refetchRun],
  );

  const errorOf = (m: { error: Error | null; variables: string | undefined }) =>
    m.error && m.variables === runId ? practiceErrorText(m.error) : null;

  return {
    runId,
    run: data,
    runPending: runId !== null && !data && !run.error,
    runError:
      run.error && !(run.error instanceof ApiClientError && run.error.status === 404)
        ? practiceErrorText(run.error)
        : null,
    /** The run belongs to another practice (adopted from `run_exists`). */
    foreign: data !== undefined && data.practiceId !== practiceId,
    start: { run: startRun, pending: start.isPending, error: startError },
    check: {
      run: () => runId && check.mutate(runId),
      pending: check.isPending && check.variables === runId,
      error: errorOf(check),
      result: checkRes,
    },
    hint: {
      run: () => runId && hint.mutate(runId),
      pending: hint.isPending,
      error: errorOf(hint),
    },
    extend: {
      run: () => runId && extend.mutate(runId),
      pending: extend.isPending,
      error: errorOf(extend),
    },
    reset: {
      run: () => runId && reset.mutate(runId),
      pending: reset.isPending,
      error: errorOf(reset),
    },
    stop: { run: () => runId && stop.mutate(runId), pending: stop.isPending, error: errorOf(stop) },
    onCtl,
    refetchRun,
  };
}

export type Incident = ReturnType<typeof useIncident>;
