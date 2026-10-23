import type { ContentVersionDto, MeDto, ProgressDto } from '@rootcamp/api-contract';
import type { Catalog, Track } from '@rootcamp/content-schema';
import { layerHash } from '@rootcamp/logic';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ROUTER_FUTURE } from '../src/config';
import { PathIndex, PathScreen } from '../src/screens/Path/PathScreen';
import { meDto } from './utils';

const VERSION = 'abcdef123456';

function lessons(section: string, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const lessonId = `${section}.l0${i + 1}`;
    return { kind: 'lesson' as const, lessonId, title: `Урок ${lessonId}` };
  });
}

const t1: Track = {
  id: 't1',
  order: 1,
  title: 'Linux: терминал',
  description: '',
  status: 'partial',
  prerequisites: [],
  reviewedAt: '2026-10-01',
  sections: [
    {
      id: 't1.s01',
      title: 'Терминал',
      description: '',
      lessonCount: 3,
      nodes: lessons('t1.s01', 3),
    },
    { id: 't1.s02', title: 'Файлы', description: '', lessonCount: 2, nodes: lessons('t1.s02', 2) },
  ],
};

const t7: Track = {
  ...t1,
  id: 't7',
  order: 7,
  title: 'Docker',
  sections: [
    { id: 't7.s01', title: 'Образы', description: '', lessonCount: 1, nodes: lessons('t7.s01', 1) },
  ],
};

// Listed out of order on purpose: «/» falls back to the first track by `order`.
const catalog: Catalog = { version: VERSION, tracks: [t7, t1] };

function progress(completedLessonIds: string[]): ProgressDto {
  return {
    completedLessonIds,
    practiceStatuses: {},
    dueCount: 4,
    tracks: [
      { id: 't1', completedLessons: completedLessonIds.length, totalLessons: 5, done: false },
      { id: 't7', completedLessons: 0, totalLessons: 1, done: false },
    ],
  };
}

const me: MeDto = {
  ...meDto({ emailVerified: true, rank: 'user', totalXp: 215 }),
  hearts: { count: 4, msToNext: 60_000 },
  streak: { current: 3, best: 5 },
  xpToday: 15,
  rank: 'user',
};

let completed: string[] = [];

const server = setupServer(
  http.get('*/api/me', () => HttpResponse.json(me)),
  http.get('*/api/content/version', () =>
    HttpResponse.json({
      version: VERSION,
      baseUrl: `/content/${VERSION}/`,
    } satisfies ContentVersionDto),
  ),
  http.get(`*/content/${VERSION}/catalog.json`, () => HttpResponse.json(catalog)),
  http.get('*/api/progress', () => HttpResponse.json(progress(completed))),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  completed = ['t1.s01.l01'];
  window.localStorage.clear();
});

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}</output>;
}

function renderPath(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>
        <Routes>
          <Route path="/" element={<PathIndex me={me} />} />
          <Route path="/track/:trackId" element={<PathScreen me={me} />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const layer = (title: string) => screen.getByText(title).closest('li') as HTMLElement;

describe('Path screen', () => {
  it('marks l02 «СЕЙЧАС» and l03 locked after t1.s01.l01; l01 is a built layer', async () => {
    renderPath('/track/t1');

    const current = await screen.findByRole('link', { name: /Урок t1\.s01\.l02/ });
    expect(current).toHaveAttribute('href', '/lesson/t1.s01.l02');
    expect(layer('Урок t1.s01.l02')).toHaveAttribute('data-status', 'current');
    expect(within(layer('Урок t1.s01.l02')).getByText('СЕЙЧАС')).toBeInTheDocument();

    expect(layer('Урок t1.s01.l03')).toHaveAttribute('data-status', 'locked');
    expect(screen.queryByRole('link', { name: /Урок t1\.s01\.l03/ })).toBeNull();

    expect(layer('Урок t1.s01.l01')).toHaveAttribute('data-status', 'completed');
    expect(
      within(layer('Урок t1.s01.l01')).getByText(`слой ${layerHash('t1.s01.l01')}`),
    ).toBeInTheDocument();

    // the next section is locked and collapsed
    expect(screen.getByText('Файлы').closest('section')).toHaveAttribute('data-status', 'locked');
    expect(screen.queryByText('Урок t1.s02.l01')).toBeNull();
    expect(screen.getByText('1 из 5 уроков')).toBeInTheDocument();
  });

  it('header chips show XP 15/30, hearts, streak and rank; right column goal and review', async () => {
    renderPath('/track/t1');
    await screen.findByText('СЕЙЧАС');

    const chips = screen.getByRole('list', { name: 'Статус' });
    expect(within(chips).getByText('XP 15/30')).toBeInTheDocument();
    expect(within(chips).getByRole('img', { name: 'Сердечки: 4' })).toBeInTheDocument();
    expect(within(chips).getByLabelText('Серия: 3')).toBeInTheDocument();
    expect(within(chips).getByLabelText('Ранг: user')).toBeInTheDocument();

    const goal = screen.getByRole('region', { name: 'Цель на сегодня' });
    expect(goal).toHaveTextContent('15/30');
    const review = screen.getByRole('region', { name: 'Повторение' });
    expect(review).toHaveTextContent('4');
    expect(within(review).getByRole('link')).toHaveAttribute('href', '/review');
  });

  it('collapses a finished section into «N слоёв · образ собран»', async () => {
    completed = ['t1.s01.l01', 't1.s01.l02', 't1.s01.l03'];
    renderPath('/track/t1');

    expect(await screen.findByText('3 слоя · образ собран')).toBeInTheDocument();
    expect(screen.getByText('Терминал').closest('section')).toHaveAttribute('data-status', 'done');
    expect(screen.queryByText('Урок t1.s01.l01')).toBeNull();
    // the next section is the current one, expanded
    expect(within(layer('Урок t1.s02.l01')).getByText('СЕЙЧАС')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Терминал/ }));
    expect(screen.getByText('Урок t1.s01.l01')).toBeInTheDocument();
  });

  it('choosing t7 in TrackSelect goes to /track/t7 and remembers it', async () => {
    renderPath('/track/t1');
    await screen.findByText('СЕЙЧАС');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Трек' }), 't7');
    expect(screen.getByTestId('location')).toHaveTextContent('/track/t7');
    expect(await screen.findByText('Урок t7.s01.l01')).toBeInTheDocument();
    expect(window.localStorage.getItem('rc:lastTrack')).toBe('t7');
  });

  it('«/» redirects to the first track by order, or the last opened one', async () => {
    const first = renderPath('/');
    expect(await screen.findByText('/track/t1')).toBeInTheDocument();
    first.unmount();

    window.localStorage.setItem('rc:lastTrack', 't7');
    renderPath('/');
    expect(await screen.findByText('/track/t7')).toBeInTheDocument();
  });

  it('an unknown track id falls back to «/»', async () => {
    renderPath('/track/nope');
    expect(await screen.findByText('/track/t1')).toBeInTheDocument();
  });
});
