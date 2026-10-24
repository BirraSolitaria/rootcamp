import type {
  CheckResponse,
  ContentVersionDto,
  MeDto,
  PracticeListItem,
  RunDto,
} from '@rootcamp/api-contract';
import type { Catalog, PracticePublic } from '@rootcamp/content-schema';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTER_FUTURE } from '../src/config';
import { PracticeCatalog } from '../src/screens/Practice/PracticeCatalog';
import { PracticeScreen } from '../src/screens/Practice/PracticeScreen';
import { meDto } from './utils';

// xterm does not run in jsdom: the screen gets a stand-in that exposes its props.
const term = vi.hoisted(() => ({
  mounts: [] as { runId: string; compact: boolean }[],
  onCtl: undefined as ((ctl: unknown) => void) | undefined,
}));
vi.mock('../src/terminal/Terminal', async () => {
  const { useEffect } = await import('react');
  function Terminal(props: { runId: string; compact: boolean; onCtl?: (c: unknown) => void }) {
    term.onCtl = props.onCtl;
    useEffect(() => {
      term.mounts.push({ runId: props.runId, compact: props.compact });
    }, []);
    return (
      <div data-testid="terminal" data-run={props.runId} data-compact={String(props.compact)} />
    );
  }
  return { Terminal };
});

const VERSION = 'abcdef123456';
const PID = 'inc-nginx-down';
const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '22222222-2222-4222-8222-222222222222';

const practice: PracticePublic = {
  id: PID,
  title: 'Nginx не отвечает',
  track: 't1',
  brief: 'Сайт лежит. Подними nginx.',
  class: 'light',
  goals: [
    { id: 'g1', title: 'nginx запущен' },
    { id: 'g2', title: 'порт 80 слушается' },
  ],
  hintCount: 2,
  reward: { base: 50, noHintBonus: 10, hintCost: 5 },
  timeoutMin: 30,
};

const catalog: Catalog = { version: VERSION, tracks: [] };

function runDto(over: Partial<RunDto> = {}): RunDto {
  return {
    runId: RUN,
    practiceId: PID,
    state: 'ready',
    stopReason: null,
    queuePosition: null,
    expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
    hardDeadline: new Date(Date.now() + 90 * 60_000).toISOString(),
    goals: [
      { id: 'g1', passed: false },
      { id: 'g2', passed: false },
    ],
    hintsRevealed: 0,
    hints: [],
    canExtend: false,
    resetsLeft: 3,
    usage: { cpuPct: 12.4, memMb: 180, memLimitMb: 512 },
    ...over,
  };
}

const me: MeDto = meDto({ emailVerified: true, rank: 'user', totalXp: 100 });

let runs: Record<string, RunDto> = {};
let list: PracticeListItem[] = [];
const calls: { method: string; path: string }[] = [];

const server = setupServer(
  http.get('*/api/me', () => HttpResponse.json(me)),
  http.get('*/api/content/version', () =>
    HttpResponse.json({
      version: VERSION,
      baseUrl: `/content/${VERSION}/`,
    } satisfies ContentVersionDto),
  ),
  http.get(`*/content/${VERSION}/catalog.json`, () => HttpResponse.json(catalog)),
  http.get(`*/content/${VERSION}/practices/:id.json`, ({ params }) =>
    params.id === PID
      ? HttpResponse.json(practice)
      : HttpResponse.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 }),
  ),
  http.get('*/api/practices', () => HttpResponse.json(list)),
  http.get('*/api/runs/:runId', ({ params }) => {
    calls.push({ method: 'GET', path: `/api/runs/${String(params.runId)}` });
    const run = runs[String(params.runId)];
    return run
      ? HttpResponse.json(run)
      : HttpResponse.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const initialWidth = window.innerWidth;
function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
}

beforeEach(() => {
  runs = {};
  list = [];
  calls.length = 0;
  term.mounts = [];
  term.onCtl = undefined;
  window.localStorage.clear();
  setWidth(1440);
});
afterEach(() => setWidth(initialWidth));

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}</output>;
}

function renderPractice(route = `/practice/${PID}`) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>
        <Routes>
          <Route path="/practice" element={<PracticeCatalog me={me} />} />
          <Route path="/practice/:practiceId" element={<PracticeScreen me={me} />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

/** POST /api/practices/:id/runs answering `respond`; counts the requests. */
function onCreate(respond: () => Response | Promise<Response>) {
  const hits = { count: 0 };
  server.use(
    http.post('*/api/practices/:id/runs', async ({ request }) => {
      hits.count += 1;
      expect(request.headers.get('x-rc')).toBe('1');
      return respond();
    }),
  );
  return hits;
}

/** Puts an existing run in storage, as if this practice was started earlier. */
function remember(run: RunDto) {
  runs[run.runId] = run;
  window.localStorage.setItem(`rc:run:${PID}`, run.runId);
}

describe('Practice screen: before the start', () => {
  it('shows the brief, the goals, the reward and «Начать (≈ 20 с)»', async () => {
    renderPractice();
    expect(await screen.findByRole('heading', { name: 'Nginx не отвечает' })).toBeInTheDocument();
    expect(screen.getByText('Сайт лежит. Подними nginx.')).toBeInTheDocument();
    expect(screen.getByText('nginx запущен')).toBeInTheDocument();
    expect(screen.getByText('порт 80 слушается')).toBeInTheDocument();
    expect(screen.getByText(/\+50 XP/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Начать (≈ 20 с)' })).toBeEnabled();
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
  });

  it('says «≈ 40 с» for a docker class practice', async () => {
    server.use(
      http.get(`*/content/${VERSION}/practices/:id.json`, () =>
        HttpResponse.json({ ...practice, class: 'docker' }),
      ),
    );
    renderPractice();
    expect(await screen.findByRole('button', { name: 'Начать (≈ 40 с)' })).toBeInTheDocument();
  });

  it('a double click on «Начать» sends exactly one POST; the button stays disabled until the answer', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const hits = onCreate(async () => {
      await gate;
      runs[RUN] = runDto({ state: 'queued', queuePosition: 1, usage: null, expiresAt: null });
      return HttpResponse.json({ runId: RUN, state: 'queued', queuePosition: 1 }, { status: 201 });
    });
    renderPractice();
    const start = await screen.findByRole('button', { name: 'Начать (≈ 20 с)' });
    const u = userEvent.setup();
    await u.dblClick(start);
    await u.click(start);
    expect(hits.count).toBe(1);
    expect(start).toBeDisabled();

    release();
    expect(await screen.findByText('Ты 1-й в очереди')).toBeInTheDocument();
    expect(hits.count).toBe(1);
    expect(window.localStorage.getItem(`rc:run:${PID}`)).toBe(RUN);
  });

  it('409 run_exists adopts the runId from the error', async () => {
    runs[OTHER_RUN] = runDto({ runId: OTHER_RUN, state: 'starting', usage: null });
    const hits = onCreate(() =>
      HttpResponse.json(
        { error: { code: 'run_exists', message: 'busy', runId: OTHER_RUN } },
        { status: 409 },
      ),
    );
    renderPractice();
    await userEvent.click(await screen.findByRole('button', { name: 'Начать (≈ 20 с)' }));
    expect(await screen.findByText('Готовим сервер…')).toBeInTheDocument();
    expect(hits.count).toBe(1);
    expect(calls).toContainEqual({ method: 'GET', path: `/api/runs/${OTHER_RUN}` });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a run_exists of another practice links to that practice', async () => {
    runs[OTHER_RUN] = runDto({ runId: OTHER_RUN, practiceId: 'inc-disk-full' });
    onCreate(() =>
      HttpResponse.json(
        { error: { code: 'run_exists', message: 'busy', runId: OTHER_RUN } },
        { status: 409 },
      ),
    );
    renderPractice();
    await userEvent.click(await screen.findByRole('button', { name: 'Начать (≈ 20 с)' }));
    const link = await screen.findByRole('link', { name: 'Открыть запущенный инцидент' });
    expect(link).toHaveAttribute('href', '/practice/inc-disk-full');
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
  });

  it.each([
    [503, 'queue_full', 'Сейчас все серверы заняты, попробуй через 10 минут'],
    [
      403,
      'quota_exceeded',
      'На сегодня время практики закончилось (180 минут в сутки). Приходи завтра',
    ],
    [403, 'practice_locked', 'Практика пока закрыта: пройди урок перед ней'],
  ] as const)('%i %s → «%s»', async (status, code, text) => {
    onCreate(() => HttpResponse.json({ error: { code, message: code } }, { status }));
    renderPractice();
    await userEvent.click(await screen.findByRole('button', { name: 'Начать (≈ 20 с)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Начать (≈ 20 с)' })).toBeEnabled();
  });

  it('a finished run left in storage is dropped: the start card shows', async () => {
    remember(runDto({ state: 'expired', usage: null }));
    renderPractice();
    expect(await screen.findByRole('button', { name: 'Начать (≈ 20 с)' })).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(`rc:run:${PID}`)).toBeNull());
  });

  it('an unknown practice says so', async () => {
    renderPractice('/practice/inc-nope');
    expect(await screen.findByRole('alert')).toHaveTextContent('Инцидент не найден');
  });
});

describe('Practice screen: a run', () => {
  it('queued at position 2 shows «Ты 2-й в очереди» with the waiting mascot', async () => {
    remember(runDto({ state: 'queued', queuePosition: 2, usage: null, expiresAt: null }));
    renderPractice();
    expect(await screen.findByText('Ты 2-й в очереди')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Терминальная мордочка ждёт' })).toBeInTheDocument();
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
  });

  it('polls every 2 s while queued and moves on to ready with the terminal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    remember(runDto({ state: 'queued', queuePosition: 1, usage: null, expiresAt: null }));
    renderPractice();
    expect(await screen.findByText('Ты 1-й в очереди')).toBeInTheDocument();
    const before = calls.length;
    runs[RUN] = runDto({ state: 'starting', usage: null, expiresAt: null });
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText('Готовим сервер…')).toBeInTheDocument();
    expect(calls.length).toBe(before + 1);
    runs[RUN] = runDto();
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByTestId('terminal')).toHaveAttribute('data-run', RUN);
    // ready: the next poll comes after 15 s, not 2 s.
    const atReady = calls.length;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(calls.length).toBe(atReady);
    await act(() => vi.advanceTimersByTimeAsync(10_500));
    expect(calls.length).toBe(atReady + 1);
  });

  it('ready: terminal, goals, «Проверить», «Сбросить сервер», hints with the price, timer, CPU/RAM', async () => {
    remember(runDto());
    renderPractice();
    expect(await screen.findByTestId('terminal')).toHaveAttribute('data-compact', 'false');
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Сбросить сервер/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Подсказка · −5 XP/ })).toBeEnabled();
    expect(screen.getByText('CPU 12% · RAM 180 / 512 МБ')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/^2[45]:\d\d$/);
    expect(screen.getByText('Сервер готов')).toBeInTheDocument();
  });

  it('«Проверить» marks goals; the solving check shows «Решено» and the XP', async () => {
    remember(runDto());
    let solved = false;
    server.use(
      http.post('*/api/runs/:runId/check', () =>
        HttpResponse.json({
          goals: [
            { id: 'g1', passed: true, output: '' },
            { id: 'g2', passed: solved, output: solved ? '' : 'порт 80 закрыт' },
          ],
          solved,
          xpAwarded: solved ? 60 : 0,
        } satisfies CheckResponse),
      ),
    );
    renderPractice();
    const check = await screen.findByRole('button', { name: 'Проверить' });
    await userEvent.click(check);
    expect(await screen.findByText('порт 80 закрыт')).toBeInTheDocument();
    expect(screen.getByText('nginx запущен').closest('li')).toHaveAttribute('data-passed', 'true');
    expect(screen.getByText('порт 80 слушается').closest('li')).toHaveAttribute(
      'data-passed',
      'false',
    );

    solved = true;
    runs[RUN] = runDto({ state: 'solved' });
    await userEvent.click(check);
    expect(await screen.findByText('Решено')).toBeInTheDocument();
    expect(screen.getByText('+60 XP')).toBeInTheDocument();
    // The sandbox lives on for 2 minutes: the terminal stays.
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
  });

  it('a hint costs «−5 XP» and its text appears', async () => {
    remember(runDto());
    server.use(
      http.post('*/api/runs/:runId/hints', () =>
        HttpResponse.json({ index: 0, text: 'Посмотри systemctl status', hintsRevealed: 1 }),
      ),
    );
    renderPractice();
    await userEvent.click(await screen.findByRole('button', { name: /Подсказка · −5 XP/ }));
    expect(await screen.findByText('Посмотри systemctl status')).toBeInTheDocument();
  });

  it('«Сбросить сервер» asks first, then resets and remounts the terminal when ready again', async () => {
    remember(runDto());
    let resets = 0;
    server.use(
      http.post('*/api/runs/:runId/reset', () => {
        resets += 1;
        runs[RUN] = runDto({ state: 'starting', usage: null, resetsLeft: 2 });
        return HttpResponse.json({ state: 'starting' });
      }),
    );
    const { client } = renderPractice();
    await screen.findByTestId('terminal');
    await userEvent.click(screen.getByRole('button', { name: /Сбросить сервер/ }));
    expect(resets).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Да, сбросить' }));
    expect(await screen.findByText('Готовим сервер…')).toBeInTheDocument();
    expect(resets).toBe(1);
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();

    runs[RUN] = runDto({ resetsLeft: 2 });
    await act(() => client.invalidateQueries({ queryKey: ['run', RUN] }));
    expect(await screen.findByTestId('terminal')).toBeInTheDocument();
    expect(term.mounts).toHaveLength(2);
  });

  it('closed: expired from the terminal → «Время вышло» and «Новый сервер»', async () => {
    remember(runDto());
    renderPractice();
    await screen.findByTestId('terminal');
    runs[RUN] = runDto({ state: 'expired', stopReason: 'expired', usage: null });
    act(() => term.onCtl?.({ t: 'closed', reason: 'expired' }));
    expect(await screen.findByText('Время вышло')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Новый сервер' })).toBeInTheDocument();
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
  });

  it('«Новый сервер» starts a fresh run', async () => {
    remember(runDto());
    const NEW = '33333333-3333-4333-8333-333333333333';
    const hits = onCreate(() => {
      runs[NEW] = runDto({ runId: NEW, state: 'queued', queuePosition: 3, usage: null });
      return HttpResponse.json({ runId: NEW, state: 'queued', queuePosition: 3 }, { status: 201 });
    });
    renderPractice();
    await screen.findByTestId('terminal');
    runs[RUN] = runDto({ state: 'expired', stopReason: 'expired', usage: null });
    act(() => term.onCtl?.({ t: 'closed', reason: 'expired' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Новый сервер' }));
    expect(await screen.findByText('Ты 3-й в очереди')).toBeInTheDocument();
    expect(hits.count).toBe(1);
  });

  it.each([
    ['oom', 'Сервер упал (не хватило памяти)', 'Запустить заново'],
    ['crashed', 'Сервер упал', 'Запустить заново'],
    ['setup_failed', 'Не удалось подготовить инцидент. Мы уже знаем', 'Попробовать снова'],
  ])('failed (%s) → «%s»', async (reason, text, button) => {
    remember(runDto({ state: 'starting', usage: null }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPractice();
    expect(await screen.findByText('Готовим сервер…')).toBeInTheDocument();
    runs[RUN] = runDto({ state: 'failed', stopReason: reason, usage: null });
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: button })).toBeInTheDocument();
  });

  it('queue_timeout → «Сейчас все серверы заняты…» and the start button again', async () => {
    remember(runDto({ state: 'queued', queuePosition: 4, usage: null }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPractice();
    await screen.findByText('Ты 4-й в очереди');
    runs[RUN] = runDto({ state: 'queue_timeout', stopReason: 'queue_timeout', usage: null });
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(
      await screen.findByText('Сейчас все серверы заняты, попробуй через 10 минут'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Начать (≈ 20 с)' })).toBeInTheDocument();
  });

  it('5 minutes before the end a toast offers «Продлить» when canExtend', async () => {
    remember(
      runDto({ expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), canExtend: true }),
    );
    const later = new Date(Date.now() + 19 * 60_000).toISOString();
    server.use(
      http.post('*/api/runs/:runId/extend', () => {
        runs[RUN] = { ...runs[RUN]!, expiresAt: later, canExtend: false };
        return HttpResponse.json({ expiresAt: later });
      }),
    );
    renderPractice();
    const toast = await screen.findByRole('status', { name: 'Время заканчивается' });
    expect(toast).toHaveTextContent('До конца меньше 5 минут');
    await userEvent.click(within(toast).getByRole('button', { name: 'Продлить' }));
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Время заканчивается' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('timer')).toHaveTextContent(/^1[89]:\d\d$/);
  });

  it('the toast has no «Продлить» when the run cannot be extended', async () => {
    remember(runDto({ expiresAt: new Date(Date.now() + 50_000).toISOString(), canExtend: false }));
    renderPractice();
    const toast = await screen.findByRole('status', { name: 'Время заканчивается' });
    expect(toast).toHaveTextContent('До конца меньше минуты');
    expect(within(toast).queryByRole('button', { name: 'Продлить' })).not.toBeInTheDocument();
  });
});

describe('Practice screen on a phone (390 px)', () => {
  it('shows the header with «Проверить», the tabs and «Следующая цель»', async () => {
    setWidth(390);
    remember(
      runDto({
        goals: [
          { id: 'g1', passed: true },
          { id: 'g2', passed: false },
        ],
      }),
    );
    renderPractice();
    const header = await screen.findByRole('banner');
    expect(within(header).getByRole('link', { name: 'Назад' })).toHaveAttribute(
      'href',
      '/practice',
    );
    expect(within(header).getByText('Nginx не отвечает')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Проверить' })).toBeVisible();
    expect(within(header).getByRole('timer')).toBeInTheDocument();

    const tabs = screen.getByRole('tablist');
    expect(within(tabs).getByRole('tab', { name: 'Терминал' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: 'Цели 1/2' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Подсказки' })).toBeInTheDocument();
    expect(screen.getByText('Следующая цель: порт 80 слушается')).toBeInTheDocument();
    expect(await screen.findByTestId('terminal')).toHaveAttribute('data-compact', 'true');

    await userEvent.click(within(tabs).getByRole('tab', { name: 'Цели 1/2' }));
    expect(screen.getByRole('tabpanel', { name: 'Цели 1/2' })).toHaveTextContent('nginx запущен');
    // The terminal stays mounted behind the other tabs (its socket survives a tab switch).
    expect(term.mounts).toHaveLength(1);
  });
});

describe('Practice catalog', () => {
  it('lists incidents with their status; locked ones are not links', async () => {
    list = [
      {
        id: PID,
        title: 'Nginx не отвечает',
        track: 't1',
        status: 'available',
        solved: false,
        anchorLessonId: 't1.s01.l01',
      },
      {
        id: 'inc-disk-full',
        title: 'Диск забит',
        track: 't1',
        status: 'solved',
        solved: true,
        anchorLessonId: null,
      },
      {
        id: 'inc-dns',
        title: 'DNS сломан',
        track: 't1',
        status: 'locked',
        solved: false,
        anchorLessonId: 't1.s02.l01',
      },
    ];
    renderPractice('/practice');
    expect(await screen.findByRole('link', { name: /Nginx не отвечает/ })).toHaveAttribute(
      'href',
      `/practice/${PID}`,
    );
    expect(screen.getByRole('link', { name: /Диск забит/ })).toHaveTextContent('решена');
    expect(screen.queryByRole('link', { name: /DNS сломан/ })).not.toBeInTheDocument();
    expect(screen.getByText('DNS сломан').closest('li')).toHaveTextContent('закрыта');
  });

  it('an empty catalog says incidents are coming', async () => {
    renderPractice('/practice');
    expect(await screen.findByText('Инциденты появятся здесь совсем скоро.')).toBeInTheDocument();
  });
});
