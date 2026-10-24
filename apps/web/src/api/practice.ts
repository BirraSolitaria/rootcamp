import {
  CheckResponse,
  CreateRunResponse,
  ExtendRunResponse,
  HintResponse,
  PracticeListResponse,
  ResetRunResponse,
  RunDto,
  type RunState,
} from '@rootcamp/api-contract';
import { useQuery } from '@tanstack/react-query';
import { ApiClientError, apiFetch } from './client';

// Practice endpoints (spec §5.1 «Практика»). The POSTs carry no body (and so no content-type).

export const PRACTICES_KEY = ['practices'] as const;
export const runKey = (runId: string) => ['run', runId] as const;

const retry = (count: number, err: Error) => !(err instanceof ApiClientError) && count < 2;

/** The run still holds (or waits for) a sandbox. */
export const ACTIVE_STATES: readonly RunState[] = ['queued', 'starting', 'ready'];
export const isActive = (state: RunState) => ACTIVE_STATES.includes(state);

/** `GET /api/runs/:id` every 2 s while queued / starting, every 15 s while ready (§8.1). */
export function pollInterval(state: RunState | undefined): number | false {
  if (state === 'queued' || state === 'starting') return 2000;
  if (state === 'ready') return 15_000;
  return false;
}

/** `GET /api/practices`: every practice with the user's status. */
export function usePractices() {
  return useQuery({
    queryKey: PRACTICES_KEY,
    queryFn: () => apiFetch('/api/practices', undefined, PracticeListResponse),
    retry,
  });
}

/** `GET /api/runs/:runId`, polled by state; idle without a run. */
export function useRun(runId: string | null) {
  return useQuery({
    queryKey: runKey(runId ?? ''),
    queryFn: () => apiFetch(`/api/runs/${runId ?? ''}`, undefined, RunDto),
    enabled: runId !== null,
    staleTime: 0,
    retry,
    refetchInterval: (q) => pollInterval(q.state.data?.state),
  });
}

const post = { method: 'POST' } as const;

export const practiceApi = {
  createRun: (practiceId: string) =>
    apiFetch(`/api/practices/${encodeURIComponent(practiceId)}/runs`, post, CreateRunResponse),
  check: (runId: string) => apiFetch(`/api/runs/${runId}/check`, post, CheckResponse),
  hint: (runId: string) => apiFetch(`/api/runs/${runId}/hints`, post, HintResponse),
  extend: (runId: string) => apiFetch(`/api/runs/${runId}/extend`, post, ExtendRunResponse),
  reset: (runId: string) => apiFetch(`/api/runs/${runId}/reset`, post, ResetRunResponse),
  stop: (runId: string) => apiFetch<void>(`/api/runs/${runId}/stop`, post),
};

/** localStorage key of the last run started on a practice (a reload or a 2nd tab picks it up). */
export const runStorageKey = (practiceId: string) => `rc:run:${practiceId}`;

export function readStoredRun(practiceId: string): string | null {
  try {
    return window.localStorage.getItem(runStorageKey(practiceId));
  } catch {
    return null;
  }
}

export function storeRun(practiceId: string, runId: string | null): void {
  try {
    if (runId === null) window.localStorage.removeItem(runStorageKey(practiceId));
    else window.localStorage.setItem(runStorageKey(practiceId), runId);
  } catch {
    // storage unavailable: the run is only known to this page
  }
}
