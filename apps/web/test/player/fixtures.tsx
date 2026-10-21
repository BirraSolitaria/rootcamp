import type { Task, UserAnswer } from '@rootcamp/content-schema';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { TaskPlayer, type TaskPlayerProps } from '../../src/player/TaskPlayer';

export const singleChoice = {
  id: 't1.s01.l01.t01',
  type: 'single_choice',
  question: 'Какая команда показывает текущий каталог?',
  options: ['ls', 'pwd', 'cd', 'echo'],
  correctIndex: 1,
  explanation: 'pwd — print working directory.',
} as const satisfies Task;

export const trueFalse = {
  id: 't1.s01.l01.t02',
  type: 'true_false',
  statement: 'Команда cd без аргументов переходит в домашний каталог.',
  answer: true,
  explanation: 'cd без аргументов — это cd ~.',
} as const satisfies Task;

export const assemble = {
  id: 't1.s01.l01.t03',
  type: 'assemble',
  prompt: 'Собери команду: длинный список файлов',
  answer: ['ls', '-l'],
  distractors: ['-r', 'cd'],
  explanation: 'ls -l выводит подробный список.',
} satisfies Task;

export const fillBlank = {
  id: 't1.s01.l01.t04',
  type: 'fill_blank',
  prompt: 'Перейди в домашний каталог',
  template: 'cd ___',
  acceptedAnswers: ['~'],
  explanation: '~ — домашний каталог.',
} satisfies Task;

export const matchPairs = {
  id: 't1.s01.l01.t05',
  type: 'match_pairs',
  prompt: 'Соедини команду и действие',
  pairs: [
    { left: 'ls', right: 'список файлов' },
    { left: 'pwd', right: 'текущий каталог' },
    { left: 'cd', right: 'сменить каталог' },
  ],
  explanation: 'Базовые команды навигации.',
} satisfies Task;

export const orderSteps = {
  id: 't1.s01.l01.t06',
  type: 'order_steps',
  prompt: 'Расставь шаги по порядку',
  steps: ['Открыть терминал', 'Набрать команду', 'Нажать Enter', 'Прочитать вывод'],
  explanation: 'Сначала терминал, потом команда.',
} satisfies Task;

export function renderPlayer(task: Task, props: Partial<TaskPlayerProps> = {}) {
  const onSubmit = vi.fn<(a: UserAnswer) => void>();
  const onContinue = vi.fn<() => void>();
  const all: TaskPlayerProps = {
    task,
    presentation: 1,
    feedback: null,
    onSubmit,
    onContinue,
    ...props,
  };
  const result = render(<TaskPlayer {...all} />);
  return {
    ...result,
    onSubmit,
    onContinue,
    rerenderWith: (next: Partial<TaskPlayerProps>) =>
      result.rerender(<TaskPlayer {...all} {...next} />),
  };
}
