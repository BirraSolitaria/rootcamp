import type { AnswerBody, AnswerResponse, ContentVersionDto, MeDto } from '@rootcamp/api-contract';
import type { Section, Task } from '@rootcamp/content-schema';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTER_FUTURE } from '../src/config';
import { LessonScreen } from '../src/screens/Lesson/LessonScreen';
import { meDto } from './utils';

const VERSION = 'abcdef123456';
const LESSON = 't7.s05.l02';
const SESSION = '00000000-0000-4000-8000-0000000000aa';

const pwd: Task = {
  id: `${LESSON}.t01`,
  type: 'single_choice',
  question: 'Какая команда показывает текущий каталог?',
  options: ['ls', 'pwd', 'cd', 'echo'],
  correctIndex: 1,
  explanation: 'pwd — print working directory.',
};

const section: Section = {
  id: 't7.s05',
  title: 'Тома',
  description: '',
  lessons: [
    {
      id: LESSON,
      kind: 'lesson',
      title: 'Именованные тома',
      theory: { title: 'Тома переживают контейнер', blocks: [{ type: 'text', text: 'Теория.' }] },
      tasks: [pwd],
    },
  ],
};

const me: MeDto = { ...meDto({ emailVerified: true }), hearts: { count: 5, msToNext: null } };

const summary = {
  kind: 'lesson',
  lessonId: LESSON,
  mistakes: 0,
  perfect: true,
  xpGained: 15,
  xpToday: 15,
  dailyGoal: 30,
  goalJustReached: false,
  streak: 2,
  streakIncreased: true,
} as const;

const completed: AnswerResponse = {
  correct: true,
  correctAnswerText: 'pwd',
  hearts: { count: 5, msToNext: null },
  status: 'completed',
  nextTaskId: null,
  presentation: 0,
  summary,
};

let sectionRequests: string[] = [];
let starts = 0;
let answers: AnswerBody[] = [];
/** Answers the n-th answer request (0-based). */
let answer: (n: number) => Response = () => HttpResponse.json(completed);

const server = setupServer(
  http.get('*/api/content/version', () =>
    HttpResponse.json({
      version: VERSION,
      baseUrl: `/content/${VERSION}/`,
    } satisfies ContentVersionDto),
  ),
  http.get(`*/content/${VERSION}/sections/:file`, ({ params }) => {
    sectionRequests.push(String(params.file));
    return HttpResponse.json(section);
  }),
  http.post(`*/api/lessons/${LESSON}/start`, () => {
    starts += 1;
    return HttpResponse.json({
      sessionId: SESSION,
      hearts: { count: 5, msToNext: null },
      queue: [pwd.id],
      presentation: 1,
    });
  }),
  http.post('*/api/sessions/:id/answer', async ({ request }) => {
    answers.push((await request.json()) as AnswerBody);
    return answer(answers.length - 1);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  sectionRequests = [];
  starts = 0;
  answers = [];
  answer = () => HttpResponse.json(completed);
});

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}</output>;
}

function renderLesson() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/lesson/${LESSON}`]} future={ROUTER_FUTURE}>
        <Routes>
          <Route path="/lesson/:lessonId" element={<LessonScreen me={me} />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Theory → «Начать задания» → picks «pwd» → «Проверить». */
async function answerPwd() {
  const ev = userEvent.setup();
  await ev.click(await screen.findByRole('button', { name: 'Начать задания' }));
  await ev.click(await screen.findByRole('button', { name: 'pwd' }));
  await ev.click(screen.getByRole('button', { name: 'Проверить' }));
  return ev;
}

describe('Lesson screen', () => {
  it('a direct visit to /lesson/t7.s05.l02 loads sections/t7.s05.json and shows the theory', async () => {
    renderLesson();
    expect(
      await screen.findByRole('heading', { name: 'Тома переживают контейнер' }),
    ).toBeInTheDocument();
    expect(sectionRequests).toEqual(['t7.s05.json']);
  });

  it('retries a failed answer with the same presentation and shows the summary once', async () => {
    answer = (n) => (n === 0 ? HttpResponse.error() : HttpResponse.json(completed));
    renderLesson();
    const ev = await answerPwd();

    // the local check answers at once
    expect(screen.getByText('Верно!')).toBeInTheDocument();
    await ev.click(screen.getByRole('button', { name: 'Продолжить' }));

    expect(await screen.findByRole('heading', { name: 'Урок пройден' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Урок пройден' })).toHaveLength(1);
    expect(screen.getByText('без ошибок')).toBeInTheDocument();
    expect(screen.getByText('+15 XP')).toBeInTheDocument();
    expect(answers).toHaveLength(2);
    expect(answers.map((a) => [a.taskId, a.presentation])).toEqual([
      [pwd.id, 1],
      [pwd.id, 1],
    ]);

    await ev.click(screen.getByRole('button', { name: 'Продолжить' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/track/t7');
  });

  it('the server verdict wins: correct:false over a local true shows «Неверно»', async () => {
    answer = () =>
      HttpResponse.json({
        correct: false,
        correctAnswerText: 'pwd -P',
        hearts: { count: 4, msToNext: 1_800_000 },
        status: 'in_progress',
        nextTaskId: pwd.id,
        presentation: 2,
      } satisfies AnswerResponse);
    renderLesson();
    await answerPwd();

    const banner = await screen.findByText('Неверно');
    expect(banner.closest('[role="status"]')).toHaveTextContent('pwd -P');
    expect(screen.getByRole('img', { name: 'Сердечки: 4' })).toBeInTheDocument();
  });

  it('out of hearts: «Продолжить» opens «Сердечки кончились» with the regen timer', async () => {
    answer = () =>
      HttpResponse.json({
        correct: false,
        correctAnswerText: 'pwd',
        hearts: { count: 0, msToNext: 600_000 },
        status: 'out_of_hearts',
        nextTaskId: null,
        presentation: 0,
      } satisfies AnswerResponse);
    renderLesson();
    const ev = await answerPwd();
    await screen.findByText('Неверно');
    await ev.click(screen.getByRole('button', { name: 'Продолжить' }));

    const dialog = await screen.findByRole('dialog', { name: 'Сердечки кончились' });
    expect(dialog).toHaveTextContent('Следующее сердечко через 10:00');
    await ev.click(within(dialog).getByRole('button', { name: 'К повторению' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/review');
  });

  it('«Нет связи» + «Повторить» after the retries run out; the retry resends the answer', async () => {
    let online = false;
    answer = () => (online ? HttpResponse.json(completed) : HttpResponse.error());
    renderLesson();
    const ev = await answerPwd();
    await ev.click(screen.getByRole('button', { name: 'Продолжить' }));

    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent('Нет связи');
    expect(answers).toHaveLength(4);

    online = true;
    await ev.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Урок пройден' })).toBeInTheDocument();
    expect(new Set(answers.map((a) => a.presentation))).toEqual(new Set([1]));
    expect(screen.queryByText('Нет связи')).toBeNull();
  });

  it('409 content_changed: toast «Курс обновился, урок перезапущен» and a new start', async () => {
    answer = () =>
      HttpResponse.json(
        { error: { code: 'content_changed', message: 'the course was updated' } },
        { status: 409 },
      );
    renderLesson();
    await answerPwd();

    expect(await screen.findByText('Курс обновился, урок перезапущен')).toBeInTheDocument();
    expect(starts).toBe(2);
    // the restarted lesson shows the task again, unanswered
    expect(await screen.findByRole('button', { name: 'Проверить' })).toBeDisabled();
  });
});
