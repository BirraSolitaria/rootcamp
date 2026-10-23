import { expect, test } from '@playwright/test';
import {
  checkAndContinue,
  currentTask,
  giveAnswer,
  lessonTasks,
  openLesson,
  summaryStat,
  taskArea,
  type TaskType,
} from '../helpers/answers';
import { registerAndVerify, uniqueNick } from '../helpers/users';

const ALL_TYPES: TaskType[] = [
  'assemble',
  'fill_blank',
  'match_pairs',
  'order_steps',
  'single_choice',
  'true_false',
];

/**
 * Types answered wrong once here. All six would cost six hearts out of five and the lesson
 * could never end, so single_choice and true_false get their wrong answers in scenarios 3
 * (03-hearts) and 4 (04-review).
 */
const WRONG_ONCE: TaskType[] = ['assemble', 'fill_blank', 'match_pairs', 'order_steps'];

// Spec §10.4, scenario 2: lesson t1.s01.l01 with right and wrong answers of the task types,
// the summary, then XP in the path header.
test('урок: верные и неверные ответы всех типов, итог, XP в шапке', async ({ page }) => {
  const tasks = lessonTasks();
  await registerAndVerify(page, uniqueNick('lesson'));
  await openLesson(page);

  const wrong = new Set<TaskType>();
  const right = new Set<TaskType>();
  let answers = 0;
  while (await taskArea(page).isVisible()) {
    // 12 tasks + the 4 asked again after a mistake.
    expect(++answers, 'the lesson ends').toBeLessThanOrEqual(tasks.length + WRONG_ONCE.length);
    const task = await currentTask(page, tasks);
    const correct = !WRONG_ONCE.includes(task.type) || wrong.has(task.type);
    (correct ? right : wrong).add(task.type);
    await giveAnswer(page, task, correct);
    await checkAndContinue(page, correct);
  }

  expect([...wrong].sort()).toEqual(WRONG_ONCE);
  expect([...right].sort()).toEqual(ALL_TYPES);
  expect(answers).toBe(tasks.length + WRONG_ONCE.length);

  // Summary: 10 XP (mistakes, so no perfect bonus), 4 mistakes, daily goal 10/30.
  await expect(page.getByRole('heading', { name: 'Урок пройден' })).toBeVisible();
  await expect(summaryStat(page, 'Опыт')).toHaveText('+10 XP');
  await expect(summaryStat(page, 'Ошибки')).toHaveText(String(WRONG_ONCE.length));
  await expect(summaryStat(page, 'Цель дня')).toHaveText('10/30');

  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page).toHaveURL(/\/track\/t1$/);
  await expect(page.getByRole('list', { name: 'Статус' }).getByText('XP 10/30')).toBeVisible();
  await expect(page.getByRole('link', { name: /Что такое терминал и оболочка/ })).toContainText(
    'слой',
  );
});
