import { expect, test } from '@playwright/test';
import { registerAndVerify, uniqueNick } from '../helpers/users';

// Spec §10.4, scenario 1: registration → letter in Mailpit → link → «Путь»; then logout and
// login with the same password lead back to «Путь».
test('регистрация → письмо → Путь; выход → вход тем же паролем', async ({ page }) => {
  const nick = uniqueNick('reg');

  const { email, password } = await registerAndVerify(page, nick);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Путь' })).toBeVisible();
  await expect(page.getByText(`Привет, ${nick}!`)).toBeVisible();

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('nick')).toHaveText(nick);
});
