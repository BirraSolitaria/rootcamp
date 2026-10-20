import { beforeEach, expect, test } from 'vitest';
import type {
  AssembleTask,
  FillBlankTask,
  MatchPairsTask,
  OrderStepsTask,
  SingleChoiceTask,
  TerminalPracticeTask,
  TrueFalseTask,
  UserAnswer,
} from '@rootcamp/content-schema';
import { INTERACTIVE_TASK_TYPES } from '@rootcamp/content-schema';
import { checkAnswer, correctAnswerText, isAnswerReady, shuffleSteps } from '../src/answerCheck.js';
import { rightFor, wrongFor } from './helpers/answers.js';
import { makeTask } from './helpers/makeTrack.js';

beforeEach(() => {
  expect.hasAssertions();
});

const explanation = 'Пояснение к заданию, достаточно длинное для валидатора.';

const sc: SingleChoiceTask = {
  id: 't1.s01.l01.t01',
  explanation,
  type: 'single_choice',
  question: 'Что выбрать?',
  options: ['a', 'b', 'c'],
  correctIndex: 2,
};
const tf: TrueFalseTask = {
  id: 't1.s01.l01.t02',
  explanation,
  type: 'true_false',
  statement: 'Контейнер — это образ.',
  answer: false,
};
const asm: AssembleTask = {
  id: 't1.s01.l01.t03',
  explanation,
  type: 'assemble',
  prompt: 'Собери команду: запустить nginx в фоне',
  answer: ['docker', 'run', '-d', '-p', '80:80', 'nginx'],
  altAnswers: [['docker', 'run', '-p', '80:80', '-d', 'nginx']],
  distractors: ['start'],
};
const dup: AssembleTask = {
  id: 't1.s01.l01.t04',
  explanation,
  type: 'assemble',
  prompt: 'Собери флаги портов',
  answer: ['-p', '80:80', '-p', '443:443'],
  distractors: ['-d'],
};
const fb: FillBlankTask = {
  id: 't1.s01.l01.t05',
  explanation,
  type: 'fill_blank',
  prompt: 'Впиши недостающую часть команды',
  template: 'docker ___ -d nginx',
  acceptedAnswers: ['run', 'container run'],
};
const mp: MatchPairsTask = {
  id: 't1.s01.l01.t06',
  explanation,
  type: 'match_pairs',
  prompt: 'Сопоставь флаг и его смысл',
  pairs: [
    { left: '-d', right: 'в фоне' },
    { left: '-p', right: 'порт' },
    { left: '-e', right: 'переменная' },
  ],
};
const orderTask = (steps: string[]): OrderStepsTask => ({
  id: 't1.s01.l01.t07',
  explanation,
  type: 'order_steps',
  prompt: 'Расставь шаги',
  steps,
});
const terminalTask: TerminalPracticeTask = {
  id: 't1.s01.p-inc-x.t01',
  type: 'terminal_practice',
  practiceId: 'inc-x',
};

test('single_choice uses original index', () => {
  expect(checkAnswer(sc, { type: 'single_choice', selectedIndex: 2 })).toEqual({
    correct: true,
    correctAnswerText: 'c',
  });
  expect(checkAnswer(sc, { type: 'single_choice', selectedIndex: 0 }).correct).toBe(false);
});

test('true_false text', () => {
  expect(checkAnswer(tf, { type: 'true_false', value: true })).toEqual({
    correct: false,
    correctAnswerText: 'Неверно',
  });
  expect(checkAnswer(tf, { type: 'true_false', value: false })).toEqual({
    correct: true,
    correctAnswerText: 'Неверно',
  });
  expect(checkAnswer({ ...tf, answer: true }, { type: 'true_false', value: true })).toEqual({
    correct: true,
    correctAnswerText: 'Верно',
  });
});

test('assemble is case-sensitive and accepts altAnswers', () => {
  expect(
    checkAnswer(asm, { type: 'assemble', tokens: ['docker', 'run', '-d', '-p', '80:80', 'nginx'] })
      .correct,
  ).toBe(true);
  expect(
    checkAnswer(asm, { type: 'assemble', tokens: ['docker', 'run', '-p', '80:80', '-d', 'nginx'] })
      .correct,
  ).toBe(true);
  expect(
    checkAnswer(asm, { type: 'assemble', tokens: ['docker', 'RUN', '-d', '-p', '80:80', 'nginx'] })
      .correct,
  ).toBe(false);
  expect(checkAnswer(asm, { type: 'assemble', tokens: ['docker', 'run'] }).correct).toBe(false);
  expect(
    checkAnswer(asm, {
      type: 'assemble',
      tokens: ['docker', 'run', '-d', '-p', '80:80', 'nginx', 'start'],
    }).correct,
  ).toBe(false);
  expect(checkAnswer(asm, { type: 'assemble', tokens: [] }).correctAnswerText).toBe(
    'docker run -d -p 80:80 nginx',
  );
});

test('assemble with duplicate token texts', () => {
  expect(
    checkAnswer(dup, { type: 'assemble', tokens: ['-p', '80:80', '-p', '443:443'] }).correct,
  ).toBe(true);
  expect(
    checkAnswer(dup, { type: 'assemble', tokens: ['-p', '443:443', '-p', '80:80'] }).correct,
  ).toBe(false);
});

test('fill_blank normalizes and accepts any', () => {
  expect(checkAnswer(fb, { type: 'fill_blank', text: '  RUN ' }).correct).toBe(true);
  expect(checkAnswer(fb, { type: 'fill_blank', text: 'container\t run' }).correct).toBe(true);
  expect(checkAnswer(fb, { type: 'fill_blank', text: 'start' })).toEqual({
    correct: false,
    correctAnswerText: 'docker run -d nginx',
  });
});

test('fill_blank correctAnswerText inserts the answer literally', () => {
  const t: FillBlankTask = { ...fb, template: 'echo ___', acceptedAnswers: ['$&HOME'] };
  expect(checkAnswer(t, { type: 'fill_blank', text: 'x' }).correctAnswerText).toBe('echo $&HOME');
});

test('match_pairs one wrong pair → wrong; text lists all pairs', () => {
  const r = checkAnswer(mp, {
    type: 'match_pairs',
    pairs: [
      { left: '-d', right: 'порт' },
      { left: '-p', right: 'в фоне' },
      { left: '-e', right: 'переменная' },
    ],
  });
  expect(r).toEqual({
    correct: false,
    correctAnswerText: '-d — в фоне\n-p — порт\n-e — переменная',
  });
});

test('match_pairs all correct in any order → correct', () => {
  const r = checkAnswer(mp, {
    type: 'match_pairs',
    pairs: [
      { left: '-e', right: 'переменная' },
      { left: '-d', right: 'в фоне' },
      { left: '-p', right: 'порт' },
    ],
  });
  expect(r).toEqual({
    correct: true,
    correctAnswerText: '-d — в фоне\n-p — порт\n-e — переменная',
  });
  expect(
    checkAnswer(mp, {
      type: 'match_pairs',
      pairs: [
        { left: '-d', right: 'в фоне' },
        { left: '-p', right: 'порт' },
      ],
    }).correct,
  ).toBe(false);
});

test('order_steps: correct only when order equals steps element-wise', () => {
  const t = orderTask(['a', 'b', 'c']);
  expect(checkAnswer(t, { type: 'order_steps', order: ['a', 'b', 'c'] })).toEqual({
    correct: true,
    correctAnswerText: 'a → b → c',
  });
  expect(checkAnswer(t, { type: 'order_steps', order: ['b', 'a', 'c'] }).correct).toBe(false);
  expect(checkAnswer(t, { type: 'order_steps', order: ['a', 'b'] }).correct).toBe(false);
  expect(checkAnswer(t, { type: 'order_steps', order: ['a', 'b', 'c', 'c'] }).correct).toBe(false);
  expect(correctAnswerText(t)).toBe('a → b → c');
});

test('terminal_practice is never correct and never ready', () => {
  const anyAnswer: UserAnswer = { type: 'single_choice', selectedIndex: 0 };
  expect(checkAnswer(terminalTask, anyAnswer).correct).toBe(false);
  expect(checkAnswer(terminalTask, { type: 'order_steps', order: [] }).correct).toBe(false);
  expect(isAnswerReady(terminalTask, anyAnswer)).toBe(false);
  expect(isAnswerReady(terminalTask, null)).toBe(false);
  expect(typeof correctAnswerText(terminalTask)).toBe('string');
});

test('isAnswerReady', () => {
  expect(isAnswerReady(fb, { type: 'fill_blank', text: '   ' })).toBe(false);
  expect(isAnswerReady(fb, { type: 'fill_blank', text: ' run ' })).toBe(true);
  expect(isAnswerReady(mp, { type: 'match_pairs', pairs: [{ left: '-d', right: 'в фоне' }] })).toBe(
    false,
  );
  expect(isAnswerReady(mp, { type: 'match_pairs', pairs: mp.pairs })).toBe(true);
  expect(isAnswerReady(sc, null)).toBe(false);
  expect(isAnswerReady(sc, { type: 'single_choice', selectedIndex: 0 })).toBe(true);
  expect(isAnswerReady(tf, { type: 'true_false', value: false })).toBe(true);
  expect(isAnswerReady(asm, { type: 'assemble', tokens: [] })).toBe(false);
  expect(isAnswerReady(asm, { type: 'assemble', tokens: ['docker'] })).toBe(true);
  expect(isAnswerReady(sc, { type: 'true_false', value: true })).toBe(false);
});

test('isAnswerReady order_steps: ready when all steps are placed', () => {
  const t = orderTask(['a', 'b', 'c']);
  expect(isAnswerReady(t, { type: 'order_steps', order: ['a', 'b'] })).toBe(false);
  expect(isAnswerReady(t, { type: 'order_steps', order: ['c', 'a', 'b'] })).toBe(true);
});

test('mismatched answer type is wrong', () => {
  expect(checkAnswer(sc, { type: 'true_false', value: true })).toEqual({
    correct: false,
    correctAnswerText: 'c',
  });
  expect(checkAnswer(fb, { type: 'assemble', tokens: ['run'] }).correct).toBe(false);
  expect(checkAnswer(orderTask(['a']), { type: 'assemble', tokens: ['a'] }).correct).toBe(false);
});

test('rightFor/wrongFor helpers agree with checkAnswer for every interactive type', () => {
  for (const type of INTERACTIVE_TASK_TYPES) {
    const t = makeTask(`t1.s01.l01.t0${INTERACTIVE_TASK_TYPES.indexOf(type) + 1}`, type);
    if (t.type === 'terminal_practice') throw new Error('unexpected');
    expect(checkAnswer(t, rightFor(t)).correct).toBe(true);
    expect(checkAnswer(t, wrongFor(t)).correct).toBe(false);
  }
});

// Fisher–Yates on 3 items draws 2 numbers; rng ≈ 1 picks j = i (no swap).
const IDENTITY = 0.999;

test('shuffleSteps retries while the result equals the original order', () => {
  let calls = 0;
  const rng = () => (++calls <= 3 ? IDENTITY : 0);
  const out = shuffleSteps(['a', 'b', 'c'], rng);
  expect(out).not.toEqual(['a', 'b', 'c']);
  expect([...out].sort()).toEqual(['a', 'b', 'c']);
});

test('shuffleSteps gives up after 10 attempts', () => {
  let calls = 0;
  const rng = () => {
    calls++;
    return IDENTITY;
  };
  expect(shuffleSteps(['a', 'b', 'c'], rng)).toEqual(['a', 'b', 'c']);
  expect(calls).toBe(20);
});

test('shuffleSteps with fewer than 2 steps returns a copy', () => {
  const rng = () => 0;
  const one = ['a'];
  const out = shuffleSteps(one, rng);
  expect(out).toEqual(['a']);
  expect(out).not.toBe(one);
  expect(shuffleSteps([], rng)).toEqual([]);
});

test('shuffleSteps does not mutate input', () => {
  const steps = ['a', 'b', 'c'];
  shuffleSteps(steps, () => 0);
  expect(steps).toEqual(['a', 'b', 'c']);
});
