import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { parse } from 'yaml';

/** The lesson the scenarios play: it holds all six interactive task types (M3 constraint). */
export const LESSON_ID = 't1.s01.l01';

/** The interactive task types of the player (terminal_practice is never asked in a lesson). */
export type TaskType =
  'single_choice' | 'true_false' | 'assemble' | 'fill_blank' | 'match_pairs' | 'order_steps';

/** The fields of the content YAML the answers need (content-schema has the full shape). */
export type LessonTask = { id: string; explanation: string } & (
  | { type: 'single_choice'; question: string; options: string[]; correctIndex: number }
  | { type: 'true_false'; statement: string; answer: boolean }
  | { type: 'assemble'; prompt: string; answer: string[]; distractors: string[] }
  | { type: 'fill_blank'; prompt: string; template: string; acceptedAnswers: string[] }
  | { type: 'match_pairs'; prompt: string; pairs: { left: string; right: string }[] }
  | { type: 'order_steps'; prompt: string; steps: string[] }
);

const LESSON_FILE = fileURLToPath(new URL('../../content/tracks/t1/s01/l01.yaml', import.meta.url));

/** Tasks of `t1.s01.l01` in lesson order, straight from `content/`. */
export function lessonTasks(): LessonTask[] {
  const doc = parse(readFileSync(LESSON_FILE, 'utf8')) as { id: string; tasks: LessonTask[] };
  if (doc.id !== LESSON_ID) throw new Error(`${LESSON_FILE} holds ${doc.id}, not ${LESSON_ID}`);
  return doc.tasks;
}

/** The text that tells the task apart on screen: the heading, or the statement for true_false. */
function marker(t: LessonTask): string {
  switch (t.type) {
    case 'single_choice':
      return t.question;
    case 'true_false':
      return t.statement;
    default:
      return t.prompt;
  }
}

/** The task area of the player (`<section aria-label="Задание">`). */
export function taskArea(page: Page): Locator {
  return page.getByRole('region', { name: 'Задание' });
}

/** Which of `tasks` is on screen now. */
export async function currentTask(page: Page, tasks: LessonTask[]): Promise<LessonTask> {
  const area = taskArea(page);
  await expect(area).toBeVisible();
  const text = (await area.innerText()).replace(/\s+/g, ' ');
  const hits = tasks.filter((t) => text.includes(marker(t).replace(/\s+/g, ' ')));
  if (hits.length !== 1) {
    throw new Error(`expected one task on screen, matched ${hits.length}: ${text.slice(0, 200)}`);
  }
  return hits[0]!;
}

const button = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

/**
 * Builds the answer to `task` on screen, right (`correct`) or deliberately wrong, without
 * pressing «Проверить». order_steps is sorted with the ↑ buttons, not by dragging.
 */
export async function giveAnswer(page: Page, task: LessonTask, correct: boolean): Promise<void> {
  const area = taskArea(page);
  switch (task.type) {
    case 'single_choice': {
      const i = correct ? task.correctIndex : (task.correctIndex + 1) % task.options.length;
      const options = area.getByRole('group', { name: 'Варианты ответа' });
      await button(options, task.options[i]!).click();
      return;
    }
    case 'true_false': {
      const value = correct ? task.answer : !task.answer;
      await button(area, value ? 'Верно' : 'Неверно').click();
      return;
    }
    case 'assemble': {
      // Wrong: a distractor in place of the first token.
      const tokens = correct ? task.answer : [task.distractors[0]!, ...task.answer.slice(1)];
      const bank = area.getByRole('group', { name: 'Плитки' });
      for (const token of tokens) await button(bank, token).click();
      await expect(area.getByRole('group', { name: 'Твой ответ' })).toHaveText(
        new RegExp(tokens.map(escapeRe).join('\\s*')),
      );
      return;
    }
    case 'fill_blank': {
      await area.getByLabel('Ответ').fill(correct ? task.acceptedAnswers[0]! : 'не-знаю');
      return;
    }
    case 'match_pairs': {
      // Wrong: the first two right-hand sides swapped.
      const rights = task.pairs.map((p) => p.right);
      if (!correct) [rights[0], rights[1]] = [rights[1]!, rights[0]!];
      const left = area.getByRole('group', { name: 'Левая колонка' });
      const right = area.getByRole('group', { name: 'Правая колонка' });
      for (const [i, p] of task.pairs.entries()) {
        await button(left, p.left).click();
        await button(right, rights[i]!).click();
      }
      return;
    }
    case 'order_steps': {
      await sortSteps(area, task.steps);
      // Wrong: the last step moved one place up.
      if (!correct) await button(area, `Выше: ${task.steps.at(-1)!}`).click();
      return;
    }
  }
}

/** Steps as shown, top to bottom. */
async function shownSteps(area: Locator): Promise<string[]> {
  return area
    .getByRole('list', { name: 'Порядок шагов' })
    .locator('li[data-step]')
    .evaluateAll((items) => items.map((li) => li.getAttribute('data-step') ?? ''));
}

/** Selection sort with the ↑ buttons: brings `want[i]` up to position i, for each i. */
async function sortSteps(area: Locator, want: string[]): Promise<void> {
  for (const [i, step] of want.entries()) {
    const from = (await shownSteps(area)).indexOf(step);
    if (from < 0) throw new Error(`step not on screen: ${step}`);
    for (let k = from; k > i; k--) await button(area, `Выше: ${step}`).click();
    await expect.poll(async () => (await shownSteps(area)).indexOf(step)).toBe(i);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Presses «Проверить» and checks both verdicts: the banner («Верно!» / «Неверно») and the
 * server's `correct` in the answer response. Then presses «Продолжить» and waits for what comes
 * next: another task, the summary or «Сердечки кончились». `onBanner` runs while the banner
 * is up.
 */
export async function checkAndContinue(
  page: Page,
  expectCorrect: boolean,
  onBanner?: () => Promise<void>,
): Promise<void> {
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/sessions\/[^/]+\/answer$/.test(r.url()),
  );
  await page.getByRole('button', { name: 'Проверить' }).click();
  const res = await answered;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { correct: boolean }).correct).toBe(expectCorrect);
  // The banner, not the true_false tiles «Верно» / «Неверно».
  const banner = page
    .getByRole('status')
    .filter({ has: page.getByRole('button', { name: 'Продолжить' }) });
  // Its title; «Правильно: Неверно» of a true_false is a <pre>.
  await expect(
    banner.getByRole('paragraph').filter({ hasText: expectCorrect ? /^Верно!$/ : /^Неверно$/ }),
  ).toBeVisible();
  await onBanner?.();
  await banner.getByRole('button', { name: 'Продолжить' }).click();
  await expect(
    page
      .getByRole('button', { name: 'Проверить' })
      .or(page.getByRole('heading', { name: /^(Урок пройден|Повторение завершено)$/ }))
      .or(page.getByRole('dialog', { name: 'Сердечки кончились' })),
  ).toBeVisible();
}

/** Answers the task on screen (right or wrong) and moves on; returns the task it was. */
export async function answerCurrent(
  page: Page,
  tasks: LessonTask[],
  correct: (task: LessonTask) => boolean,
): Promise<LessonTask> {
  const task = await currentTask(page, tasks);
  const right = correct(task);
  await giveAnswer(page, task, right);
  await checkAndContinue(page, right);
  return task;
}

/** A value of the session summary (`<dt>label</dt><dd>value</dd>`). */
export function summaryStat(page: Page, label: string): Locator {
  return page
    .locator('dt')
    .filter({ hasText: new RegExp(`^${escapeRe(label)}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

/** Opens the lesson from «Путь» (the current layer) and passes the theory card. */
export async function openLesson(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/track\/t1$/);
  await page.getByRole('link', { name: /СЕЙЧАС/ }).click();
  await expect(page).toHaveURL(new RegExp(`/lesson/${escapeRe(LESSON_ID)}$`));
  await page.getByRole('button', { name: 'Начать задания' }).click();
  await expect(taskArea(page)).toBeVisible();
}
