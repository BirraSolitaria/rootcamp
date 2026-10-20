import { describe, expect, test } from 'vitest';
import { ID_RE, INTERACTIVE_TASK_TYPES, TASK_TYPES, TaskSchema } from '../src/index.js';

const explanation = 'Пояснение показывается после ответа пользователя.';

const samples = [
  {
    id: 't1.s01.l01.t01',
    type: 'single_choice',
    question: 'Какая команда показывает содержимое каталога?',
    options: ['ls', 'cd', 'pwd'],
    correctIndex: 0,
    explanation,
  },
  {
    id: 't1.s01.l01.t02',
    type: 'true_false',
    statement: 'Команда pwd печатает текущий каталог.',
    answer: true,
    explanation,
  },
  {
    id: 't1.s01.l01.t03',
    type: 'assemble',
    prompt: 'Собери команду: длинный список с скрытыми файлами',
    answer: ['ls', '-la'],
    altAnswers: [['ls', '-al']],
    distractors: ['-r'],
    explanation,
  },
  {
    id: 't1.s01.l01.t04',
    type: 'fill_blank',
    prompt: 'Впиши недостающую часть команды',
    template: '___ -la /etc',
    acceptedAnswers: ['ls'],
    explanation,
  },
  {
    id: 't1.s01.l01.t05',
    type: 'match_pairs',
    prompt: 'Сопоставь команду и её смысл',
    pairs: [
      { left: 'ls', right: 'список файлов' },
      { left: 'cd', right: 'сменить каталог' },
      { left: 'pwd', right: 'текущий каталог' },
    ],
    explanation,
  },
  {
    id: 't1.s01.l01.t06',
    type: 'order_steps',
    prompt: 'Расположи шаги в правильном порядке',
    steps: ['Открыть терминал', 'Ввести команду', 'Нажать Enter'],
    explanation,
  },
  {
    id: 't1.s01.p-inc-nginx-down.t01',
    type: 'terminal_practice',
    practiceId: 'inc-nginx-down',
  },
] as const;

describe('TaskSchema', () => {
  test.each(samples)('accepts a valid $type task', (sample) => {
    expect(TaskSchema.parse(sample)).toEqual(sample);
  });

  test('samples cover every task type', () => {
    expect(samples.map((s) => s.type)).toEqual([...TASK_TYPES]);
  });

  test('rejects unknown fields (strict objects)', () => {
    expect(TaskSchema.safeParse({ ...samples[1], extra: 1 }).success).toBe(false);
  });

  test('rejects an unknown task type', () => {
    expect(TaskSchema.safeParse({ ...samples[1], type: 'essay' }).success).toBe(false);
  });

  test('rejects a task missing a required field', () => {
    const withoutIndex: Record<string, unknown> = { ...samples[0] };
    delete withoutIndex.correctIndex;
    expect(TaskSchema.safeParse(withoutIndex).success).toBe(false);
  });
});

describe('task type lists', () => {
  test('TASK_TYPES has all 7 types', () => {
    expect(TASK_TYPES).toHaveLength(7);
  });

  test('INTERACTIVE_TASK_TYPES excludes terminal_practice', () => {
    expect(INTERACTIVE_TASK_TYPES).toHaveLength(6);
    expect(INTERACTIVE_TASK_TYPES).not.toContain('terminal_practice');
  });
});

describe('ID_RE', () => {
  test('matches spec examples', () => {
    expect(ID_RE.track.test('t7')).toBe(true);
    expect(ID_RE.section.test('t7.s03')).toBe(true);
    expect(ID_RE.lesson.test('t7.s03.l02')).toBe(true);
    expect(ID_RE.task.test('t7.s03.l02.t07')).toBe(true);
    expect(ID_RE.practice.test('inc-nginx-down')).toBe(true);
    expect(ID_RE.goal.test('http-200')).toBe(true);
  });

  test('rejects malformed IDs', () => {
    expect(ID_RE.lesson.test('t7.s03.l2')).toBe(false);
    expect(ID_RE.track.test('t123')).toBe(false);
    expect(ID_RE.task.test('t7.s03.l02.t07x')).toBe(false);
    expect(ID_RE.practice.test('inc-ab')).toBe(false);
    expect(ID_RE.goal.test('Http-200')).toBe(false);
  });
});
