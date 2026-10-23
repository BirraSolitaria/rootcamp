import {
  AnswerResponse,
  type AnswerBody,
  type ContentVersionDto,
  type HeartsDto,
  MeDto,
  type ReviewMode,
  StartLessonResponse,
  StartReviewResponse,
  type SummaryDto,
} from '@rootcamp/api-contract';
import type { Task, UserAnswer } from '@rootcamp/content-schema';
import { checkAnswer } from '@rootcamp/logic';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ApiClientError, apiFetch } from '../../api/client';
import { ME_KEY } from '../../api/queries';
import {
  CONTENT_VERSION_KEY,
  PROGRESS_KEY,
  refreshContentVersion,
  useSections,
} from '../../content/useContent';
import type { Feedback } from '../../player/TaskPlayer';

/** What to play: one lesson, or a review / drill («тренировка»). */
export type LearningKind =
  { kind: 'lesson'; lessonId: string } | { kind: 'review'; mode: ReviewMode };

/** Waits before the 2nd, 3rd and 4th attempt of an answer lost to the network (§9). */
export const ANSWER_RETRY_DELAYS = [200, 400, 800] as const;

export const CONTENT_CHANGED_TOAST = 'Курс обновился, урок перезапущен';
const TOAST_MS = 5000;

/** `t7.s05.l02` / `t7.s05.l02.t01` → `t7.s05` (§4.1 ids). */
export function sectionOf(id: string): string {
  return id.split('.').slice(0, 2).join('.');
}

/** The task on screen and its answer round trip. */
export interface ActiveTask {
  sessionId: string;
  taskId: string;
  presentation: number;
  hearts: HeartsDto;
  /** Tasks in the session and how many are done (lesson: solved; review: answered). */
  total: number;
  done: number;
  /** Local verdict first, replaced by the server's. */
  feedback: Feedback | null;
  /** The answer being sent; resent as is (same `presentation`) by a retry. */
  pending: AnswerBody | null;
  response: AnswerResponse | null;
  sending: boolean;
  /** Every attempt failed on the network: «Нет связи» + «Повторить». */
  offline: boolean;
  /** «Продолжить» was pressed before the server answered. */
  continueRequested: boolean;
}

export type SessionState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  /** `204` of `POST /api/review/start`: nothing to ask. */
  | { phase: 'empty' }
  | ({ phase: 'task' } & ActiveTask)
  | { phase: 'out_of_hearts'; msToNext: number | null }
  | { phase: 'summary'; summary: SummaryDto }
  | { phase: 'error'; error: unknown };

type Action =
  | { type: 'start' }
  | { type: 'started'; task: ActiveTask }
  | { type: 'empty' }
  | { type: 'out_of_hearts'; msToNext: number | null }
  | { type: 'submit'; feedback: Feedback; body: AnswerBody }
  | { type: 'sending' }
  | { type: 'offline' }
  | { type: 'response'; response: AnswerResponse }
  | { type: 'continue' }
  | { type: 'fail'; error: unknown };

/** After «Продолжить» with the server's answer in hand. */
function advance(s: ActiveTask, res: AnswerResponse, kind: LearningKind['kind']): SessionState {
  if (res.status === 'completed' && res.summary) return { phase: 'summary', summary: res.summary };
  if (res.status === 'out_of_hearts')
    return { phase: 'out_of_hearts', msToNext: res.hearts.msToNext };
  if (res.nextTaskId === null) {
    return { phase: 'error', error: new Error('session ended without a summary') };
  }
  return {
    ...s,
    phase: 'task',
    taskId: res.nextTaskId,
    presentation: res.presentation,
    hearts: res.hearts,
    done: s.done + (kind === 'review' || res.correct ? 1 : 0),
    feedback: null,
    pending: null,
    response: null,
    sending: false,
    offline: false,
    continueRequested: false,
  };
}

function reducer(kind: LearningKind['kind']) {
  return (state: SessionState, action: Action): SessionState => {
    switch (action.type) {
      case 'start':
        return { phase: 'starting' };
      case 'started':
        return { phase: 'task', ...action.task };
      case 'empty':
        return { phase: 'empty' };
      case 'out_of_hearts':
        return { phase: 'out_of_hearts', msToNext: action.msToNext };
      case 'fail':
        return { phase: 'error', error: action.error };
    }
    if (state.phase !== 'task') return state;
    switch (action.type) {
      case 'submit':
        return { ...state, feedback: action.feedback, pending: action.body };
      case 'sending':
        return { ...state, sending: true, offline: false };
      case 'offline':
        return { ...state, sending: false, offline: true };
      case 'continue':
        return state.response
          ? advance(state, state.response, kind)
          : { ...state, continueRequested: true };
      case 'response': {
        const res = action.response;
        const disagrees = state.feedback !== null && state.feedback.correct !== res.correct;
        const next: ActiveTask = {
          ...state,
          hearts: res.hearts,
          feedback: {
            correct: res.correct,
            correctAnswerText: res.correctAnswerText,
            explanation: state.feedback?.explanation ?? '',
          },
          response: res,
          sending: false,
          offline: false,
          // A different verdict is a new banner: it waits for its own «Продолжить».
          continueRequested: disagrees ? false : state.continueRequested,
        };
        return next.continueRequested ? advance(next, res, kind) : { phase: 'task', ...next };
      }
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request that never reached the server (`fetch` rejected), as opposed to an api error. */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

/**
 * State of a lesson or review screen (§5.1, §9). Starts the session as soon as `kind` is set
 * (null: not yet), loads the sections holding its tasks, checks an answer locally (the banner
 * shows at once) and sends it; the server's verdict replaces the local one. A send lost to the
 * network is retried up to 3 times with the same `presentation` (idempotent), then waits for
 * «Повторить». `409 content_changed` restarts the session with a toast, on the reloaded version.
 */
export function useLearningSession(kind: LearningKind | null) {
  const qc = useQueryClient();
  const key =
    kind === null
      ? null
      : kind.kind === 'lesson'
        ? `lesson:${kind.lessonId}`
        : `review:${kind.mode}`;
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const [state, dispatch] = useReducer(reducer(kind?.kind ?? 'lesson'), { phase: 'idle' });
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  // Bumped by every start and on unmount: answers of an older session are dropped.
  const gen = useRef(0);

  // The header and a later start's «Сердечки кончились» read hearts from the `me` cache.
  const setMeHearts = useCallback(
    (hearts: HeartsDto) => qc.setQueryData<MeDto>(ME_KEY, (me) => me && { ...me, hearts }),
    [qc],
  );

  /**
   * Starts a session. `resync` (a restart after an error or `409 content_changed`) first reloads
   * the active content version, which is cached forever otherwise. The session's own
   * `contentVersion` is checked too: a tab left open across a content redeploy would look its
   * tasks up in the old version's files.
   */
  const start = useCallback(
    async (resync = false) => {
      const k = kindRef.current;
      if (k === null) return;
      const g = ++gen.current;
      dispatch({ type: 'start' });
      const syncVersion = async (sessionVersion: string) => {
        const cached = qc.getQueryData<ContentVersionDto>(CONTENT_VERSION_KEY);
        if (cached !== undefined && cached.version !== sessionVersion) {
          await refreshContentVersion(qc);
        }
      };
      try {
        if (resync) {
          await refreshContentVersion(qc);
          if (g !== gen.current) return;
        }
        if (k.kind === 'lesson') {
          const res = await apiFetch(
            `/api/lessons/${encodeURIComponent(k.lessonId)}/start`,
            { method: 'POST' },
            StartLessonResponse,
          );
          if (g !== gen.current) return;
          await syncVersion(res.contentVersion);
          if (g !== gen.current) return;
          const first = res.queue[0];
          if (first === undefined) throw new Error('empty lesson queue');
          setTaskIds(res.queue);
          setMeHearts(res.hearts);
          dispatch({ type: 'started', task: fresh(res.sessionId, first, res, res.queue.length) });
        } else {
          const res = await apiFetch(
            '/api/review/start',
            { method: 'POST', json: { mode: k.mode } },
            StartReviewResponse.optional(),
          );
          if (g !== gen.current) return;
          if (res === undefined) return dispatch({ type: 'empty' });
          await syncVersion(res.contentVersion);
          if (g !== gen.current) return;
          setTaskIds(res.taskIds);
          setMeHearts(res.hearts);
          dispatch({
            type: 'started',
            task: fresh(res.sessionId, res.taskIds[0]!, res, res.taskIds.length),
          });
        }
      } catch (err) {
        if (g !== gen.current) return;
        if (err instanceof ApiClientError && err.code === 'no_hearts') {
          // The refusal carries no timer: take it from a fresh `GET /api/me`.
          const latest = await qc
            .fetchQuery({
              queryKey: ME_KEY,
              queryFn: () => apiFetch('/api/me', undefined, MeDto),
              staleTime: 0,
            })
            .catch(() => undefined);
          if (g !== gen.current) return;
          dispatch({ type: 'out_of_hearts', msToNext: latest?.hearts.msToNext ?? null });
        } else {
          dispatch({ type: 'fail', error: err });
        }
      }
    },
    [qc, setMeHearts],
  );

  useEffect(() => {
    if (key === null) return;
    void start();
    return () => {
      gen.current += 1;
    };
  }, [key, start]);

  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const send = useCallback(
    async (sessionId: string, body: AnswerBody) => {
      const g = gen.current;
      dispatch({ type: 'sending' });
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await apiFetch(
            `/api/sessions/${sessionId}/answer`,
            { method: 'POST', json: body },
            AnswerResponse,
          );
          if (g !== gen.current) return;
          setMeHearts(res.hearts);
          return dispatch({ type: 'response', response: res });
        } catch (err) {
          if (g !== gen.current) return;
          if (!isNetworkError(err)) {
            if (err instanceof ApiClientError && err.code === 'content_changed') {
              setToast(CONTENT_CHANGED_TOAST);
              // The new version (and progress) is loaded before the new session shows a task.
              return void start(true);
            }
            return dispatch({ type: 'fail', error: err });
          }
          const wait = ANSWER_RETRY_DELAYS[attempt];
          if (wait === undefined) return dispatch({ type: 'offline' });
          await sleep(wait);
          if (g !== gen.current) return;
        }
      }
    },
    [start, setMeHearts],
  );

  // Tasks come from the public section files of the active content version.
  const sectionIds = [...new Set(taskIds.map(sectionOf))];
  const sections = useSections(state.phase === 'task' ? sectionIds : []);
  let task: Task | null = null;
  if (state.phase === 'task') {
    for (const s of sections.data ?? []) {
      for (const l of s.lessons) {
        task ??= l.tasks.find((t) => t.id === state.taskId) ?? null;
      }
    }
  }
  /** The task is missing from the content (or is a terminal_practice): it cannot be played. */
  const unplayable =
    state.phase === 'task' &&
    sections.data !== undefined &&
    (task === null || task.type === 'terminal_practice');

  const submit = useCallback(
    (answer: UserAnswer) => {
      if (state.phase !== 'task' || state.pending !== null) return;
      if (task === null || task.type === 'terminal_practice') return;
      const local = checkAnswer(task, answer);
      const body: AnswerBody = { taskId: state.taskId, presentation: state.presentation, answer };
      dispatch({
        type: 'submit',
        body,
        feedback: { ...local, explanation: task.explanation },
      });
      void send(state.sessionId, body);
    },
    [state, task, send],
  );

  const retry = useCallback(() => {
    if (state.phase !== 'task' || state.pending === null || state.sending) return;
    void send(state.sessionId, state.pending);
  }, [state, send]);

  const onContinue = useCallback(() => dispatch({ type: 'continue' }), []);

  /** «Начать заново»: reloads the content version, then starts a new session. */
  const restart = useCallback(() => start(true), [start]);

  // The summary changed XP, hearts, streak and progress.
  const finished = state.phase === 'summary';
  useEffect(() => {
    if (!finished) return;
    void qc.invalidateQueries({ queryKey: ME_KEY });
    void qc.invalidateQueries({ queryKey: PROGRESS_KEY });
  }, [finished, qc]);

  return {
    state,
    task: unplayable ? null : task,
    unplayable,
    contentError: sections.error,
    toast,
    submit,
    onContinue,
    retry,
    restart,
  };
}

function fresh(
  sessionId: string,
  taskId: string,
  res: { hearts: HeartsDto; presentation: number },
  total: number,
): ActiveTask {
  return {
    sessionId,
    taskId,
    presentation: res.presentation,
    hearts: res.hearts,
    total,
    done: 0,
    feedback: null,
    pending: null,
    response: null,
    sending: false,
    offline: false,
    continueRequested: false,
  };
}

export type LearningSession = ReturnType<typeof useLearningSession>;
