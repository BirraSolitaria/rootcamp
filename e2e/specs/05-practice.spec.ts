import { expect, test, type Locator, type Page } from '@playwright/test';
import { seriousViolations } from '../helpers/axe';
import { seedProgress } from '../helpers/stand';
import { registerAndVerify, uniqueNick } from '../helpers/users';

/** The fixture practice (e2e/fixtures/content), placed after t1.s01.l01 by its overlay. */
const PRACTICE = 'inc-e2e-touch';
const TITLE = 'E2E: создай файл-флажок';
/** reward.base 20 + noHintBonus 10 (no hints opened). */
const XP = 30;
/** The api allows one check per 5 s per user. */
const CHECK_GAP_MS = 5_500;

/** The Terminal's root (`data-state` = its socket state). */
function terminal(page: Page): Locator {
  return page.locator('[data-state]').filter({ has: page.locator('.xterm') });
}

/** The visible rows of the xterm screen (DOM renderer), trimmed. */
async function screenRows(page: Page): Promise<string[]> {
  const rows = await page.locator('.xterm-rows > div').allInnerTexts();
  return rows.map((r) => r.replace(/\u00a0/g, ' ').trim());
}

/** Types `line` into the terminal and presses Enter. */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

let sizeProbe = 0;
/** `stty size` of the sandbox's pane ("rows cols"), via a marker line unique to this call. */
async function sttySize(page: Page): Promise<string> {
  const marker = `SZ${++sizeProbe}`;
  await typeLine(page, `echo "${marker}:$(stty size)"`);
  const re = new RegExp(`^${marker}:(\\d+ \\d+)$`);
  let size = '';
  await expect
    .poll(
      async () => {
        for (const row of await screenRows(page)) {
          const m = re.exec(row);
          if (m) size = m[1]!;
        }
        return size;
      },
      { message: `output of ${marker}`, timeout: 10_000 },
    )
    .not.toBe('');
  return size;
}

// Spec §10.4, scenario 5: practice on rc/test-shell (runc-dev). Start, `echo hi` in the terminal,
// a network drop (context.setOffline) → reconnect with the history in place, `resize`,
// «Проверить» with the goal red, `touch /tmp/done`, «Проверить» → «Решено» and the XP.
// The drop comes right after `echo hi`, while `hi` is surely still on the visible screen: on
// reattach tmux redraws only the visible pane, and later commands could scroll it away on 390 px.
test('практика: терминал, обрыв сети, resize, проверка, решено', async ({
  page,
  context,
}, testInfo) => {
  // Boot of the sandbox (image already built) + two checks 5 s apart + a 5 s outage.
  test.setTimeout(180_000);
  const phone = testInfo.project.name === 'mobile';

  const { email } = await registerAndVerify(page, uniqueNick('prac'));
  seedProgress(email, ['t1.s01.l01']);

  await page.goto(`/practice/${PRACTICE}`);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  const start = page.getByRole('button', { name: /^Начать/ });
  await expect(start).toBeVisible();
  expect(await seriousViolations(page), 'Практика: до старта').toEqual([]);

  await start.click();
  await expect(terminal(page)).toHaveAttribute('data-state', 'open', { timeout: 90_000 });
  expect(await seriousViolations(page), 'Практика: терминал').toEqual([]);

  await typeLine(page, 'echo hi');
  await expect.poll(() => screenRows(page), { message: 'hi in the terminal' }).toContain('hi');

  // Network drop: the socket goes, the banner shows; back online it reattaches to the same tmux.
  await context.setOffline(true);
  const dropped = Date.now();
  await expect(page.getByText('Переподключаемся…')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(Math.max(0, 5_000 - (Date.now() - dropped)));
  await context.setOffline(false);
  await expect(terminal(page)).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
  await expect(page.getByText('Переподключаемся…')).toBeHidden();
  await expect.poll(() => screenRows(page), { message: 'history after reconnect' }).toContain('hi');

  // Resize: the new viewport refits xterm and the server resizes the pty (stty size changes).
  const before = await sttySize(page);
  await page.setViewportSize(phone ? { width: 390, height: 600 } : { width: 1200, height: 640 });
  await expect
    .poll(() => sttySize(page), { message: 'stty size after resize', timeout: 30_000 })
    .not.toBe(before);

  // Not fixed yet: the goal is red.
  const check = page.getByRole('button', { name: 'Проверить' });
  await check.click();
  const checkedAt = Date.now();
  const goal = page.locator('li[data-checked="true"]');
  await expect(goal).toHaveAttribute('data-passed', 'false');
  await expect(page.getByText('Решено')).toHaveCount(0);

  await typeLine(page, 'touch /tmp/done');
  await page.waitForTimeout(Math.max(0, CHECK_GAP_MS - (Date.now() - checkedAt)));
  await check.click();

  const solved = page.getByRole('status').filter({ hasText: 'Решено' });
  await expect(solved).toBeVisible();
  await expect(solved).toContainText(`+${XP} XP`);
  await expect(page.locator('li[data-passed="true"]')).toHaveCount(1);
  if (!phone) {
    // The practice header's chips (the phone header has none: the banner shows the XP there).
    await expect(page.getByRole('list', { name: 'Статус' }).getByText(`XP ${XP}/30`)).toBeVisible();
  }
});
