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

test('voice uses Memory: your facts, a search by meaning, a save with Undo, all kept after a reload', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  // A fact Wren saves from typed chat, and a note of your own.
  await sendMessage(page, 'I am vegetarian.')
  await expect(page.getByTestId('memory-saved')).toHaveCount(1, { timeout: 20_000 })
  const note = await page.request.post('/api/memory', { data: { kind: 'note', text: 'Dinner ideas: lentil curry and mushroom risotto.' } })
  expect(note.status()).toBe(201)

  await page.goto('/')
  await scope(page).getByTestId('mic').click()
  // A spoken turn: Wren was given the fact at the start. ("Hello Wren" is small talk, so no "facts used" check.)
  const spoken = page.getByTestId('answer').filter({ hasText: 'Hi, I’m the mock Wren.' })
  await expect(spoken).toContainText('Keeping in mind: I am vegetarian.', { timeout: 15_000 })
  await expect(spoken.getByTestId('recall-chip')).toHaveCount(0)

  // A question: Wren searches Memory (search_memory) and finds the note.
  await composer(page).fill('Any dinner ideas with lentil curry?')
  await scope(page).getByTestId('send').click()
  const found = page.getByTestId('answer').filter({ hasText: 'From your notes:' })
  await expect(found).toContainText('Dinner ideas: lentil curry and mushroom risotto.')
  await expect(found.getByTestId('recall-chip')).toHaveText(['Dinner ideas: lentil curry and mushroom risotto.', 'I am vegetarian.'])

  // "Remember that ...": saved (save_to_memory), shown under what was said, with Undo.
  await composer(page).fill('Please remember that my sister’s name is Maya.')
  await scope(page).getByTestId('send').click()
  await expect(page.getByTestId('answer').filter({ hasText: 'Saved: my sister’s name is Maya.' })).toHaveCount(1)
  const saved = page.getByTestId('memory-saved').filter({ hasText: 'my sister’s name is Maya' })
  await expect(saved).toHaveCount(1)
  await expect(saved).toContainText('Saved to Memory')
  await expect(saved).toContainText('my sister’s name is Maya')
  await expect(saved.getByTestId('memory-undo')).toBeVisible()
  await noHorizontalScroll(page)

  // Wren's own saves from voice run in batches; the last one when the session ends, and its line shows without a reload.
  await composer(page).fill('My dog is called Juniper.')
  await scope(page).getByTestId('send').click()
  await expect(page.getByTestId('answer').filter({ hasText: 'You typed: My dog is called Juniper.' })).toHaveCount(1)
  await scope(page).getByTestId('voice-end').click()
  await expect(scope(page).getByTestId('voice-panel')).toBeHidden()
  await expect(page.getByTestId('memory-saved').filter({ hasText: 'My dog is called Juniper.' })).toHaveCount(1, { timeout: 15_000 })

  // Kept with the chat.
  await page.reload()
  await expect(page.getByTestId('answer').filter({ hasText: 'From your notes:' }).getByTestId('recall-chip')).toHaveCount(2)
  const maya = page.getByTestId('memory-saved').filter({ hasText: 'my sister’s name is Maya' })
  await expect(maya).toHaveCount(1)
  await expect(page.getByTestId('memory-saved').filter({ hasText: 'My dog is called Juniper.' })).toHaveCount(1)
  await maya.getByTestId('memory-undo').click()
  await expect(maya).toContainText('Removed from Memory')
  const notes = (await (await page.request.get('/api/memory?kind=note')).json()).memories as { text: string }[]
  expect(notes.map((n) => n.text)).toEqual(['Dinner ideas: lentil curry and mushroom risotto.'])
})
