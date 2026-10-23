import { expect, test } from '@playwright/test';
import { answerCurrent, lessonTasks, openLesson, summaryStat, taskArea } from '../helpers/answers';
import { shiftReviewDueDates } from '../helpers/stand';
import { registerAndVerify, uniqueNick } from '../helpers/users';

const DAY_MS = 24 * 60 * 60 * 1000;

// Spec §10.4, scenario 4: a mistake in the lesson → a day later «Повторение (1)»; the right
// answer there gives +1 XP and +1 heart.
test('повторение после ошибки: +1 день → «Повторение (1)», +1 XP, +1 сердечко', async ({
  page,
}) => {
  const tasks = lessonTasks();
  const nick = uniqueNick('review');
  await registerAndVerify(page, nick);
  await openLesson(page);

  // One wrong answer (t01, single_choice): 4 hearts left, the task due tomorrow.
  const missed = await answerCurrent(page, tasks, () => false);
  expect(missed.id).toBe(tasks[0]!.id);
  await page.getByRole('link', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/track\/t1$/);

  // Today nothing is due yet.
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Тренировка' })).toBeVisible();

  // +1 day: the browser's clock, and the server-side due date (the api keeps its own clock).
  await page.clock.setSystemTime(Date.now() + DAY_MS);
  expect(shiftReviewDueDates(nick)).toBe(1);

  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Повторение (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Начать' }).click();
  await expect(taskArea(page)).toBeVisible();

  const asked = await answerCurrent(page, tasks, () => true);
  expect(asked.id).toBe(missed.id);

  await expect(page.getByRole('heading', { name: 'Повторение завершено' })).toBeVisible();
  await expect(summaryStat(page, 'Опыт')).toHaveText('+1 XP');
  await expect(summaryStat(page, 'Верно')).toHaveText('1 из 1');
  await expect(summaryStat(page, 'Награда')).toHaveText('+1 сердечко');
});
