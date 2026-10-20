import { randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { latestMail } from './mailpit';

/** A password that passes the 10–128 rule. */
export const E2E_PASSWORD = 'e2e-correct-horse-battery';

/**
 * A nick unique across runs and projects (`^[a-z0-9_.]{3,20}$`): `prefix` (≤ 8 chars) plus
 * 10 hex characters.
 */
export function uniqueNick(prefix = 'e2e'): string {
  return `${prefix.slice(0, 8)}_${randomBytes(5).toString('hex')}`;
}

/**
 * Registers `nick` through the UI, checks the «Проверь почту» screen, follows the confirmation
 * link from Mailpit and lands on «Путь». Returns the credentials for a later login.
 */
export async function registerAndVerify(
  page: Page,
  nick: string,
): Promise<{ email: string; password: string }> {
  const email = `${nick.replace(/\./g, '_')}@e2e.rootcamp.test`;
  const password = E2E_PASSWORD;

  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Ник').fill(nick);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();

  await expect(page).toHaveURL(/\/check-email$/);
  await expect(page.getByRole('heading', { name: 'Проверь почту' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  const mail = await latestMail(email);
  const link = mail.links.find((l) => new URL(l).pathname === '/verify');
  if (!link) throw new Error(`no /verify link in the letter: ${mail.text}`);
  // The link must point at the stand itself (the api's PUBLIC_ORIGIN = Playwright's baseURL).
  expect(new URL(link).origin).toBe(new URL(page.url()).origin);

  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Почта подтверждена' })).toBeVisible();
  await page.getByRole('link', { name: 'К обучению' }).click();
  await expect(page.getByTestId('nick')).toHaveText(nick);

  return { email, password };
}
