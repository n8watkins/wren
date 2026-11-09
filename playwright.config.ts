import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against the real Worker build (OpenNext, D1, Durable
 * Objects) served by wrangler on port 3121 (scripts/e2e-server.mjs), with local
 * mocks of the Gemini API on 3127 (tests/mocks/gemini.mjs) and the Tavily API on
 * 3128 (tests/mocks/tavily.mjs). Every spec runs at desktop width and at
 * phone width.
 */
const PORT = process.env.E2E_PORT ?? '3121'
const MOCK = process.env.MOCK_GEMINI_PORT ?? '3127'
const TAVILY = process.env.MOCK_TAVILY_PORT ?? '3128'
// 127.0.0.2, not localhost: under WSL's mirrored networking a connection to a
// closed port on 127.0.0.1 hangs for minutes instead of being refused, and
// Playwright probes each server's port before starting it. 127.0.0.2 is plain
// Linux loopback everywhere, CI included.
const HOST = '127.0.0.2'
const BASE_URL = `http://${HOST}:${PORT}`

// Test browsers make no sound (under WSLg they would play through Windows).
process.env.PULSE_SERVER = 'unix:/nonexistent'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retries hide flakiness; fix flaky tests instead.
  retries: 0,
  workers: process.env.CI ? 2 : 3,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'api', testMatch: /api\.spec\.ts/ },
    {
      name: 'desktop',
      testIgnore: /(api|guest-cap)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'phone',
      testIgnore: /(api|guest-cap)\.spec\.ts/,
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
    // The site-wide guest cap, last: it uses up the day's guest messages.
    { name: 'guest-cap', testMatch: /guest-cap\.spec\.ts/, dependencies: ['api', 'desktop', 'phone'] },
  ],
  webServer: [
    {
      command: 'node tests/mocks/gemini.mjs',
      url: `http://${HOST}:${MOCK}/health`,
      reuseExistingServer: false,
      env: { MOCK_GEMINI_PORT: MOCK, E2E_HOST: HOST },
    },
    {
      command: 'node tests/mocks/tavily.mjs',
      url: `http://${HOST}:${TAVILY}/health`,
      reuseExistingServer: false,
      env: { MOCK_TAVILY_PORT: TAVILY, E2E_HOST: HOST },
    },
    {
      command: 'node scripts/e2e-server.mjs',
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: { E2E_PORT: PORT, MOCK_GEMINI_PORT: MOCK, MOCK_TAVILY_PORT: TAVILY, E2E_HOST: HOST },
    },
  ],
})
