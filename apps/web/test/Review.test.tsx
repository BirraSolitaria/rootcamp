import type {
  AnswerResponse,
  ContentVersionDto,
  MeDto,
  ProgressDto,
  StartReviewBody,
} from '@rootcamp/api-contract';
import type { Section } from '@rootcamp/content-schema';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTER_FUTURE } from '../src/config';
import { ReviewScreen } from '../src/screens/Review/ReviewScreen';
import { meDto } from './utils';

const VERSION = 'abcdef123456';
const SESSION = '00000000-0000-4000-8000-0000000000bb';

function section(id: string, statement: string): Section {
  return {
    id,
    title: id,
    description: '',
    lessons: [
      {
        id: `${id}.l01`,
        kind: 'lesson',
        title: 'Урок',
        theory: { title: 'Теория', blocks: [] },
        tasks: [
          {
            id: `${id}.l01.t01`,
            type: 'true_false',
            statement,
            answer: true,
            explanation: 'Так и есть.',
          },
        ],
      },
    ],
  };
}

const sections: Record<string, Section> = {
  't1.s01': section('t1.s01', 'pwd печатает текущий каталог.'),
  't7.s02': section('t7.s02', 'docker ps показывает запущенные контейнеры.'),
};

const me: MeDto = { ...meDto({ emailVerified: true }), hearts: { count: 2, msToNext: 60_000 } };

let dueCount = 2;
let startBodies: StartReviewBody[] = [];
let startStatus: 200 | 204 = 200;
let answered = 0;

function progress(): ProgressDto {
  return { completedLessonIds: ['t1.s01.l01'], practiceStatuses: {}, dueCount, tracks: [] };
}

function answerResponse(): AnswerResponse {
  answered += 1;
  const last = answered === 2;
  return {
    correct: true,
    correctAnswerText: 'Верно',
    hearts: { count: last ? 3 : 2, msToNext: 60_000 },
    status: last ? 'completed' : 'in_progress',
    nextTaskId: last ? null : 't7.s02.l01.t01',
    presentation: last ? 0 : 2,
    ...(last && {
      summary: {
        kind: 'review',
        mode: 'review',
        correct: 2,
        total: 2,
        heartGained: true,
        xpGained: 2,
        xpToday: 12,
        dailyGoal: 30,
        goalJustReached: false,
        streak: 1,
        streakIncreased: false,
      },
    }),
  };
}

const server = setupServer(
  http.get('*/api/progress', () => HttpResponse.json(progress())),
  http.get('*/api/content/version', () =>
    HttpResponse.json({
      version: VERSION,
      baseUrl: `/content/${VERSION}/`,
    } satisfies ContentVersionDto),
  ),
  http.get(`*/content/${VERSION}/sections/:file`, ({ params }) =>
    HttpResponse.json(sections[String(params.file).replace(/\.json$/, '')]),
  ),
  http.post('*/api/review/start', async ({ request }) => {
    startBodies.push((await request.json()) as StartReviewBody);
    if (startStatus === 204) return new HttpResponse(null, { status: 204 });
    return HttpResponse.json({
      sessionId: SESSION,
      taskIds: ['t1.s01.l01.t01', 't7.s02.l01.t01'],
      hearts: { count: 2, msToNext: 60_000 },
      presentation: 1,
    });
  }),
  http.post('*/api/sessions/:id/answer', () => HttpResponse.json(answerResponse())),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  dueCount = 2;
  startBodies = [];
  startStatus = 200;
  answered = 0;
});

function renderReview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/review']} future={ROUTER_FUTURE}>
        <Routes>
          <Route path="/review" element={<ReviewScreen me={me} />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Review screen', () => {
  it('«Повторение (N)»: tasks from several sections, then the summary with +1 heart', async () => {
    const ev = userEvent.setup();
    renderReview();
    expect(await screen.findByRole('heading', { name: 'Повторение (2)' })).toBeInTheDocument();
    await ev.click(screen.getByRole('button', { name: 'Начать' }));
    expect(startBodies).toEqual([{ mode: 'review' }]);

    expect(await screen.findByText('pwd печатает текущий каталог.')).toBeInTheDocument();
    await ev.click(screen.getByRole('button', { name: 'Верно' }));
    await ev.click(screen.getByRole('button', { name: 'Проверить' }));
    await ev.click(await screen.findByRole('button', { name: 'Продолжить' }));

    expect(
      await screen.findByText('docker ps показывает запущенные контейнеры.'),
    ).toBeInTheDocument();
    await ev.click(screen.getByRole('button', { name: 'Верно' }));
    await ev.click(screen.getByRole('button', { name: 'Проверить' }));
    await ev.click(await screen.findByRole('button', { name: 'Продолжить' }));

    expect(
      await screen.findByRole('heading', { name: 'Повторение завершено' }),
    ).toBeInTheDocument();
    expect(screen.getByText('+1 сердечко')).toBeInTheDocument();
    expect(screen.getByText('2 из 2')).toBeInTheDocument();
  });

  it('«Тренировка» when nothing is due; 204 → «Пока нечего тренировать»', async () => {
    dueCount = 0;
    startStatus = 204;
    const ev = userEvent.setup();
    renderReview();
    expect(await screen.findByRole('heading', { name: 'Тренировка' })).toBeInTheDocument();
    await ev.click(screen.getByRole('button', { name: 'Начать' }));
    expect(await screen.findByText('Пока нечего тренировать')).toBeInTheDocument();
    expect(startBodies).toEqual([{ mode: 'drill' }]);
  });
});
