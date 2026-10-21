import type { LessonSummary, ReviewSummary } from '@rootcamp/logic';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HeartsIndicator } from '../../src/player/HeartsIndicator';
import { OutOfHearts } from '../../src/player/OutOfHearts';
import { ProgressBar } from '../../src/player/ProgressBar';
import { Summary } from '../../src/player/Summary';
import { TheoryCardView } from '../../src/player/TheoryCardView';
import { matchPairs, renderPlayer, singleChoice, trueFalse } from './fixtures';

const wrong = { correct: false, correctAnswerText: 'pwd', explanation: singleChoice.explanation };
const right = { correct: true, correctAnswerText: 'pwd', explanation: singleChoice.explanation };

describe('TaskPlayer', () => {
  it('FeedbackBanner shows «Неверно» and correctAnswerText after a wrong answer', async () => {
    const ev = userEvent.setup();
    const { onSubmit, rerenderWith } = renderPlayer(singleChoice);
    await ev.click(screen.getByRole('button', { name: 'ls' }));
    await ev.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(onSubmit).toHaveBeenCalledWith({ type: 'single_choice', selectedIndex: 0 });

    rerenderWith({ feedback: wrong });
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Неверно');
    expect(banner).toHaveTextContent('Правильно:');
    expect(banner).toHaveTextContent('pwd');
    expect(banner).toHaveTextContent(singleChoice.explanation);
    expect(screen.queryByRole('button', { name: 'Проверить' })).toBeNull();
    // the task is locked while the banner is up
    expect(screen.getByRole('button', { name: 'cd' })).toBeDisabled();
  });

  it('FeedbackBanner on a correct answer: «Верно!», no correct-answer line', () => {
    renderPlayer(singleChoice, { feedback: right });
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Верно!');
    expect(banner).not.toHaveTextContent('Правильно:');
  });

  it('keeps line breaks of a multi-line correct answer', () => {
    renderPlayer(matchPairs, {
      feedback: { correct: false, correctAnswerText: 'ls — a\npwd — b', explanation: 'x' },
    });
    expect(screen.getByText(/ls — a/).tagName).toBe('PRE');
  });

  it('moves focus to «Продолжить»; Enter continues exactly once', async () => {
    const ev = userEvent.setup();
    const { onContinue } = renderPlayer(singleChoice, { feedback: wrong });
    const cont = screen.getByRole('button', { name: 'Продолжить' });
    expect(cont).toHaveFocus();
    await ev.keyboard('{Enter}');
    await ev.keyboard('{Enter}');
    await ev.click(cont);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('Enter with focus on the page body continues too', async () => {
    const ev = userEvent.setup();
    const { onContinue } = renderPlayer(singleChoice, { feedback: right });
    act(() => (document.activeElement as HTMLElement).blur());
    await ev.keyboard('{Enter}');
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('submits once even if «Проверить» is pressed twice before feedback arrives', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(trueFalse);
    await ev.click(screen.getByRole('button', { name: 'Верно' }));
    await ev.click(screen.getByRole('button', { name: 'Проверить' }));
    await ev.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled();
  });

  it('a new presentation of the same task starts with an empty answer', async () => {
    const ev = userEvent.setup();
    const { rerenderWith } = renderPlayer(trueFalse);
    await ev.click(screen.getByRole('button', { name: 'Верно' }));
    rerenderWith({ feedback: wrong });
    rerenderWith({ feedback: null, presentation: 2 });
    expect(screen.getByRole('button', { name: 'Верно' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled();
  });

  it('Enter on an unrelated control outside the player is left alone', async () => {
    const ev = userEvent.setup();
    const onExit = vi.fn();
    render(
      <button type="button" onClick={onExit}>
        Выйти
      </button>,
    );
    const { onSubmit: submitted } = renderPlayer(trueFalse);
    await ev.keyboard('1');
    screen.getByRole('button', { name: 'Выйти' }).focus();
    await ev.keyboard('{Enter}');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe('player parts', () => {
  it('TheoryCardView renders text and code blocks and starts the tasks', async () => {
    const ev = userEvent.setup();
    const onStart = vi.fn();
    render(
      <TheoryCardView
        theory={{
          title: 'Терминал',
          blocks: [
            { type: 'text', text: 'Оболочка читает команды.' },
            { type: 'code', code: '$ pwd\n/home/neo' },
          ],
        }}
        onStart={onStart}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Терминал' })).toBeInTheDocument();
    expect(screen.getByText(/\/home\/neo/).tagName).toBe('PRE');
    await ev.click(screen.getByRole('button', { name: 'Начать задания' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('HeartsIndicator shows the count and the regen timer when not full', () => {
    const { rerender } = render(<HeartsIndicator count={3} msToNext={65_000} />);
    expect(screen.getByLabelText('Сердечки: 3')).toHaveTextContent('3');
    expect(screen.getByText('+1 через 01:05')).toBeInTheDocument();
    rerender(<HeartsIndicator count={5} msToNext={null} />);
    expect(screen.queryByText(/через/)).toBeNull();
  });

  it('ProgressBar exposes its value', () => {
    render(<ProgressBar value={0.25} />);
    expect(screen.getByRole('progressbar', { name: 'Прогресс урока' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
  });

  it('OutOfHearts counts down to the next heart', () => {
    vi.useFakeTimers();
    const onReview = vi.fn();
    render(<OutOfHearts msToNext={3_000} onReview={onReview} onHome={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Сердечки кончились' })).toBeInTheDocument();
    expect(screen.getByText('Следующее сердечко через 00:03')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('Следующее сердечко через 00:02')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText('Сердечко уже восстановилось')).toBeInTheDocument();
    screen.getByRole('button', { name: 'К повторению' }).click();
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('Summary of a perfect lesson: XP, «без ошибок», daily goal, streak', () => {
    const summary: LessonSummary = {
      kind: 'lesson',
      lessonId: 't1.s01.l01',
      mistakes: 0,
      perfect: true,
      xpGained: 15,
      xpToday: 30,
      dailyGoal: 30,
      goalJustReached: true,
      streak: 3,
      streakIncreased: true,
    };
    render(<Summary summary={summary} onContinue={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Урок пройден' })).toBeInTheDocument();
    expect(screen.getByText('+15 XP')).toBeInTheDocument();
    expect(screen.getByText('без ошибок')).toBeInTheDocument();
    expect(screen.getByText('30/30')).toBeInTheDocument();
    expect(screen.getByText('Цель дня выполнена!')).toBeInTheDocument();
    expect(screen.getByText('3 дня')).toBeInTheDocument();
  });

  it('Summary of a review: +XP and +1 heart', () => {
    const summary: ReviewSummary = {
      kind: 'review',
      mode: 'review',
      correct: 1,
      total: 1,
      heartGained: true,
      xpGained: 1,
      xpToday: 11,
      dailyGoal: 30,
      goalJustReached: false,
      streak: 1,
      streakIncreased: false,
    };
    render(<Summary summary={summary} onContinue={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Повторение завершено' })).toBeInTheDocument();
    expect(screen.getByText('+1 XP')).toBeInTheDocument();
    expect(screen.getByText('+1 сердечко')).toBeInTheDocument();
    expect(screen.getByText('1 из 1')).toBeInTheDocument();
  });
});
