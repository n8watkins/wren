import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { composer, isPhone, noHorizontalScroll, sendMessage, signIn } from './helpers'

/**
 * Voice in the browser, against the Gemini Live mock (tests/mocks/live.mjs):
 * Chromium's fake mic sends a tone, the mock hears about a second of it and
 * answers one turn with a tone of its own and a transcript.
 */
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
})

const scope = (page: Page) => page.locator(isPhone(page) ? '.mcomp' : '.composer')

/** Counts the audio Wren sends back, from inside the page. */
async function countAudio(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __voiceAudio: number }
    w.__voiceAudio = 0
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.addEventListener('message', (event) => {
          if (event.data instanceof ArrayBuffer) w.__voiceAudio += event.data.byteLength
        })
      }
    }
  })
}

test('talk, hear Wren, see both turns saved, then end', async ({ page, baseURL }) => {
  await countAudio(page)
  await signIn(page, baseURL!)
  await scope(page).getByTestId('mic').click()
  const panel = scope(page).getByTestId('voice-panel')
  await expect(panel).toBeVisible()
  await expect(scope(page).getByTestId('mic')).toHaveAttribute('aria-pressed', 'true')
  await expect(scope(page).getByTestId('voice-left')).toHaveText(/^(10:00|9:\d\d) left$/)

  // The spoken turn lands in a new chat, the person first.
  await expect(page.getByTestId('user-message')).toHaveText(['Hello Wren'], { timeout: 15_000 })
  await expect(page.getByTestId('answer')).toContainText('Hi, I’m the mock Wren.')
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
  expect(await page.evaluate(() => (window as unknown as { __voiceAudio: number }).__voiceAudio)).toBeGreaterThan(40_000)
  await expect(panel).toHaveAttribute('data-status', /listening|talking/)
  await noHorizontalScroll(page)

  await panel.getByTestId('voice-end').click()
  await expect(panel).toBeHidden()
  await expect(scope(page).getByTestId('mic')).toHaveAttribute('aria-pressed', 'false')
  const usage = await (await page.request.get('/api/usage')).json()
  expect(usage.voiceMinutes.used).toBeGreaterThan(0)
  expect(usage.voiceMinutes.used).toBeLessThan(1)

  await page.reload()
  await expect(page.getByTestId('user-message')).toHaveText(['Hello Wren'])
  await expect(page.getByTestId('answer')).toHaveCount(1)
})

test('typing while talking is answered out loud and saved in the same chat', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'Typed first')
  await expect(page.getByTestId('answer')).toContainText('You said: "Typed first"')
  await scope(page).getByTestId('mic').click()
  await expect(scope(page).getByTestId('voice-status')).toHaveText('Listening')
  await composer(page).fill('What about now?')
  await scope(page).getByTestId('send').click()
  await expect(page.getByTestId('user-message')).toContainText(['Typed first', 'What about now?'])
  await expect(page.getByTestId('answer').filter({ hasText: 'You typed: What about now?' })).toHaveCount(1)
  await scope(page).getByTestId('voice-end').click()
  await page.reload()
  await expect(page.getByTestId('user-message').first()).toHaveText('Typed first')
  await expect(page.getByTestId('answer').filter({ hasText: 'You typed: What about now?' })).toHaveCount(1)
})

test('when Gemini drops the session, the person is told and the mic is free again', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await scope(page).getByTestId('mic').click()
  await expect(scope(page).getByTestId('voice-status')).toHaveText('Listening')
  await composer(page).fill('mock:drop')
  await scope(page).getByTestId('send').click()
  await expect(scope(page).getByTestId('chat-error')).toContainText('Gemini ended the voice session. Tap the mic to start again.')
  await expect(scope(page).getByTestId('voice-panel')).toBeHidden()
  await expect(scope(page).getByTestId('mic')).toHaveAttribute('aria-pressed', 'false')
})

test('a blocked mic says how to fix it', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
  })
  await signIn(page, baseURL!)
  await scope(page).getByTestId('mic').click()
  await expect(scope(page).getByTestId('chat-error')).toContainText('the microphone is blocked')
  await expect(scope(page).getByTestId('voice-panel')).toBeHidden()
})

test('with no voice minutes left, the person is told before anything opens', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await page.route('**/api/voice/ticket', (route) =>
    route.fulfill({ status: 429, json: { error: 'voice_daily_limit', message: 'limit' } })
  )
  await scope(page).getByTestId('mic').click()
  await expect(scope(page).getByTestId('chat-error')).toContainText('You’ve used today’s 10 voice minutes')
  await expect(scope(page).getByTestId('voice-panel')).toBeHidden()
  await noHorizontalScroll(page)
})

test('a rejected personal key is shown as that, never swapped for the demo key', async ({ page, baseURL }) => {
  await page.addInitScript(() => window.localStorage.setItem('wren:gemini-key', 'bad-key-for-voice'))
  await signIn(page, baseURL!)
  await scope(page).getByTestId('mic').click()
  await expect(scope(page).getByTestId('chat-error')).toContainText('Gemini rejected your API key')
  const usage = await (await page.request.get('/api/usage')).json()
  expect(usage.voiceMinutes.used).toBe(0)
})
