import { expect, test } from '@playwright/test';
import { answerCurrent, lessonTasks, openLesson } from '../helpers/answers';
import { registerAndVerify, uniqueNick } from '../helpers/users';

// Spec §10.4, scenario 3: five mistakes spend all five hearts → «Сердечки кончились» with a
// timer to the next heart. The first five tasks of t1.s01.l01 are single_choice, true_false,
// match_pairs, fill_blank and order_steps: one wrong answer of each.
test('сердечки: 5 ошибок → «Сердечки кончились» с таймером', async ({ page }) => {
  const tasks = lessonTasks();
  await registerAndVerify(page, uniqueNick('hearts'));
  await openLesson(page);

  const seen = [];
  for (let i = 0; i < 5; i++) {
    seen.push((await answerCurrent(page, tasks, () => false)).id);
  }
  expect(seen).toEqual(tasks.slice(0, 5).map((t) => t.id));

  const dialog = page.getByRole('dialog', { name: 'Сердечки кончились' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Сердечки кончились' })).toBeVisible();
  // REGEN_MS is 30 min: the first heart is due in 29:5x.
  await expect(dialog.getByText(/^Следующее сердечко через (29|30):\d\d$/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'К повторению' })).toBeFocused();

  // Starting the lesson again is refused for the same reason.
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^Следующее сердечко через \d\d:\d\d$/)).toBeVisible();
});
