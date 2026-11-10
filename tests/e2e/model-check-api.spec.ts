import { expect, test } from './fixtures'

/**
 * The daily model check end to end, against the Gemini, Live and Tavily mocks:
 * the cron runs (wrangler dev's /__scheduled, which only exists under
 * --test-scheduled, never in production), and /api/health reports what it
 * found without calling anything itself.
 */

test('the daily check calls every dependency and health reports the result', async ({ request }) => {
  const scheduled = await request.get('/__scheduled?cron=0+14+*+*+*')
  expect(scheduled.ok()).toBe(true)

  const health = await (await request.get('/api/health')).json()
  expect(health.checks.models.ok).toBe(true)
  expect(health.checks.models.detail).toMatch(/^5 of 5 answered \d+ min ago$/)
  expect(Object.keys(health.models.results).sort()).toEqual(['chat', 'chatFallback', 'embedding', 'live', 'tavily'])
  for (const result of Object.values(health.models.results) as { ok: boolean; ms: number }[]) {
    expect(result.ok).toBe(true)
    expect(result.ms).toBeGreaterThanOrEqual(0)
  }
  expect(Date.now() - Date.parse(health.models.ranAt)).toBeLessThan(60_000)
  expect(JSON.stringify(health)).not.toMatch(/test-demo-key|test-tavily-key/)
})
