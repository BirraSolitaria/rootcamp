import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { currentTask, giveAnswer, lessonTasks, taskArea } from '../helpers/answers';
import { registerAndVerify, uniqueNick } from '../helpers/users';

/** axe violations of impact `serious` or `critical`, as short readable lines. */
async function seriousViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help} — ${v.nodes
          .slice(0, 5)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    );
}

// Spec §10.4: «Путь» and «Урок» (theory, a task, the answer banner) without serious/critical
// axe violations.
test('доступность: Путь и Урок без нарушений serious/critical', async ({ page }) => {
  await registerAndVerify(page, uniqueNick('a11y'));

  await page.goto('/');
  await expect(page).toHaveURL(/\/track\/t1$/);
  await expect(page.getByRole('link', { name: /СЕЙЧАС/ })).toBeVisible();
  expect(await seriousViolations(page), 'Путь').toEqual([]);

  await page.getByRole('link', { name: /СЕЙЧАС/ }).click();
  await expect(page.getByRole('button', { name: 'Начать задания' })).toBeVisible();
  expect(await seriousViolations(page), 'Урок: теория').toEqual([]);

  await page.getByRole('button', { name: 'Начать задания' }).click();
  await expect(taskArea(page)).toBeVisible();
  expect(await seriousViolations(page), 'Урок: задание').toEqual([]);

  const task = await currentTask(page, lessonTasks());
  await giveAnswer(page, task, false);
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.getByRole('button', { name: 'Продолжить' })).toBeFocused();
  expect(await seriousViolations(page), 'Урок: ответ').toEqual([]);
});
