import { expect, test } from '@playwright/test';
import {
  checkAndContinue,
  currentTask,
  giveAnswer,
  lessonTasks,
  taskArea,
  type TaskType,
} from '../helpers/answers';
import { seriousViolations } from '../helpers/axe';
import { registerAndVerify, uniqueNick } from '../helpers/users';

// Spec §10.4: «Путь» and «Урок» without serious/critical axe violations. The lesson is checked
// on the theory card, on the first task of each type (before and after «Проверить», one answer
// wrong so both banners are seen) and on the summary.
test('доступность: Путь и Урок без нарушений serious/critical', async ({ page }) => {
  const tasks = lessonTasks();
  await registerAndVerify(page, uniqueNick('a11y'));

  await page.goto('/');
  await expect(page).toHaveURL(/\/track\/t1$/);
  await expect(page.getByRole('link', { name: /СЕЙЧАС/ })).toBeVisible();
  expect(await seriousViolations(page), 'Путь').toEqual([]);

  await page.getByRole('link', { name: /СЕЙЧАС/ }).click();
  await expect(page.getByRole('button', { name: 'Начать задания' })).toBeVisible();
  expect(await seriousViolations(page), 'Урок: теория').toEqual([]);

  await page.getByRole('button', { name: 'Начать задания' }).click();
  const seen = new Set<TaskType>();
  let wrongGiven = false;
  while (await taskArea(page).isVisible()) {
    const task = await currentTask(page, tasks);
    const first = !seen.has(task.type);
    seen.add(task.type);
    if (first) expect(await seriousViolations(page), `Урок: ${task.type}`).toEqual([]);
    const correct = wrongGiven || task.type !== 'true_false';
    if (!correct) wrongGiven = true;
    await giveAnswer(page, task, correct);
    if (first) {
      expect(await seriousViolations(page), `Урок: ${task.type}, ответ собран`).toEqual([]);
    }
    await checkAndContinue(page, correct, async () => {
      if (first) {
        expect(await seriousViolations(page), `Урок: ${task.type}, баннер`).toEqual([]);
      }
    });
  }
  expect(seen.size).toBe(6);

  await expect(page.getByRole('heading', { name: 'Урок пройден' })).toBeVisible();
  expect(await seriousViolations(page), 'Урок: итог').toEqual([]);

  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page).toHaveURL(/\/track\/t1$/);
  await expect(page.getByRole('link', { name: /слой/ }).first()).toBeVisible();
  expect(await seriousViolations(page), 'Путь после урока').toEqual([]);
});
