import { defineConfig } from '@playwright/test';

/** The e2e stand (infra/compose.e2e.yaml); 127.0.0.1, not localhost (R-M2-4). */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8081';

export default defineConfig({
  testDir: './specs',
  // Scenarios share one stand and the per-IP rate limits; keep them sequential.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A retry is one more registration from the same IP (`register` is 3/h).
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
});
