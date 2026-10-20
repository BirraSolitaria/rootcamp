import { normalize } from '@rootcamp/content-schema';
import type { CheckResult, Task, UserAnswer } from '@rootcamp/content-schema';
import { shuffle } from './shuffle.js';

/** Human-readable correct answer shown in the result banner. */
export function correctAnswerText(task: Task): string {
  switch (task.type) {
    case 'single_choice':
      return task.options[task.correctIndex] ?? '';
    case 'true_false':
      return task.answer ? 'Верно' : 'Неверно';
    case 'assemble':
      return task.answer.join(' ');
    case 'fill_blank':
      // function replacer: insert the answer literally (no `$&`-style patterns)
      return task.template.replace('___', () => task.acceptedAnswers[0] ?? '');
    case 'match_pairs':
      return task.pairs.map((p) => `${p.left} — ${p.right}`).join('\n');
    case 'order_steps':
      return task.steps.join(' → ');
    case 'terminal_practice':
      return '';
  }
}

function sequenceEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

function isCorrect(task: Task, answer: UserAnswer): boolean {
  if (task.type === 'single_choice' && answer.type === 'single_choice') {
    return answer.selectedIndex === task.correctIndex;
  }
  if (task.type === 'true_false' && answer.type === 'true_false') {
    return answer.value === task.answer;
  }
  if (task.type === 'assemble' && answer.type === 'assemble') {
    const candidates = [task.answer, ...(task.altAnswers ?? [])];
    return candidates.some((c) => sequenceEqual(answer.tokens, c));
  }
  if (task.type === 'fill_blank' && answer.type === 'fill_blank') {
    const text = normalize(answer.text);
    return task.acceptedAnswers.some((a) => normalize(a) === text);
  }
  if (task.type === 'match_pairs' && answer.type === 'match_pairs') {
    return (
      answer.pairs.length === task.pairs.length &&
      task.pairs.every((p) => answer.pairs.some((u) => u.left === p.left && u.right === p.right))
    );
  }
  if (task.type === 'order_steps' && answer.type === 'order_steps') {
    return sequenceEqual(answer.order, task.steps);
  }
  // answer type differs from task type, or terminal_practice (solved via the practice flow)
  return false;
}

export function checkAnswer(task: Task, answer: UserAnswer): CheckResult {
  return { correct: isCorrect(task, answer), correctAnswerText: correctAnswerText(task) };
}

/** When the «Проверить» button is enabled. */
export function isAnswerReady(task: Task, answer: UserAnswer | null): boolean {
  if (answer === null || answer.type !== task.type) return false;
  switch (answer.type) {
    case 'single_choice':
    case 'true_false':
      return true;
    case 'assemble':
      return answer.tokens.length >= 1;
    case 'fill_blank':
      return normalize(answer.text) !== '';
    case 'match_pairs':
      return task.type === 'match_pairs' && answer.pairs.length === task.pairs.length;
    case 'order_steps':
      return task.type === 'order_steps' && answer.order.length === task.steps.length;
  }
}

const MAX_SHUFFLE_ATTEMPTS = 10;

/**
 * Initial order for an order_steps task: reshuffles while the result equals
 * the correct order (at most 10 attempts). Fewer than 2 steps → a copy.
 */
export function shuffleSteps(steps: string[], rng: () => number): string[] {
  if (steps.length < 2) return steps.slice();
  let out = shuffle(steps, rng);
  for (let attempt = 1; attempt < MAX_SHUFFLE_ATTEMPTS && sequenceEqual(out, steps); attempt++) {
    out = shuffle(steps, rng);
  }
  return out;
}
