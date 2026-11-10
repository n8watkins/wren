import { expect, test } from './fixtures'
import { isPhone, newEmail, noHorizontalScroll, requestLink, sendMessage, signIn } from './helpers'

/**
 * Memory in chat, as a signed-in person uses it, at desktop and phone widths:
 * Wren's saves with Undo, the Save to Memory button, and "From your Memory"
 * chips. The mock Gemini (tests/mocks/gemini.mjs) saves each sentence that
 * says "I" or "my" as a fact, and its embeddings match by shared words.
 */

const chatIdFrom = (url: string) => /\/chat\/([0-9a-f-]{36})/.exec(url)?.[1] ?? ''

test('Wren saves what you tell it, shows it with Undo, and Undo sticks after a reload', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'My dog is called Juniper.')
  await expect(page.getByTestId('answer')).toHaveAttribute('data-status', 'done', { timeout: 20_000 })

  const saved = page.getByTestId('memory-saved')
  await expect(saved).toHaveCount(1)
  await expect(saved).toContainText('Saved to Memory')
  await expect(saved).toContainText('My dog is called Juniper.')
  await noHorizontalScroll(page)

  await saved.getByTestId('memory-undo').click()
  await expect(saved).toContainText('Removed from Memory')
  await expect(saved.getByTestId('memory-undo')).toHaveCount(0)
  expect((await (await page.request.get('/api/memory')).json()).memories).toHaveLength(0)

  await page.reload()
  await expect(page.getByTestId('memory-saved')).toContainText('Removed from Memory')
})

test('Save to Memory saves a message once, says so, and keeps saying so after a reload', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'Remember: the attic needs insulating before winter.')
  const answer = page.getByTestId('answer')
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 20_000 })

  // Wren's answer: a double click saves it once.
  const save = answer.getByTestId('save-to-memory')
  await save.dblclick()
  await expect(answer.locator('[data-testid=save-to-memory][data-saved]')).toHaveText('Saved to memory')

  // Your own message: the button beside it (shown on hover on a desktop).
  const turn = page.locator('.uturn')
  if (!isPhone(page)) await turn.hover()
  await turn.getByTestId('save-to-memory').click()
  await expect(turn.locator('[data-testid=save-to-memory][data-saved]')).toBeVisible()
  await noHorizontalScroll(page)

  const notes = (await (await page.request.get('/api/memory?kind=note')).json()).memories as { text: string }[]
  expect(notes.map((n) => n.text).sort()).toEqual(['Remember: the attic needs insulating before winter.', expect.stringContaining('You said:')].sort())

  await page.reload()
  await expect(page.locator('[data-testid=save-to-memory][data-saved]')).toHaveCount(2)

  // Saved shows where it went: the Memory page, with the memory marked.
  await page.getByTestId('answer').locator('[data-testid=save-to-memory][data-saved]').click()
  await expect(page).toHaveURL(/\/memory#m-/)
  await expect(page.locator('[data-testid=memory-item][data-focused]')).toContainText('You said:')
})

test('a new chat recalls what matters: "From your Memory" chips that open the memory', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'My dog is called Juniper.')
  await expect(page.getByTestId('memory-saved')).toHaveCount(1, { timeout: 20_000 })

  await page.goto('/')
  await sendMessage(page, 'What is my dog called?')
  const answer = page.getByTestId('answer')
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  const chip = answer.getByTestId('recall-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveText('My dog is called Juniper.')
  await expect(answer.getByTestId('recall')).toContainText('From your Memory')
  await noHorizontalScroll(page)

  // Kept with the answer.
  await page.reload()
  await expect(page.getByTestId('recall-chip')).toHaveText('My dog is called Juniper.')

  // Something unrelated gets no chip.
  await page.goto('/')
  await sendMessage(page, 'Tell me about volcanoes')
  await expect(page.getByTestId('answer')).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await expect(page.getByTestId('recall')).toHaveCount(0)

  await page.goBack()
  await page.getByTestId('recall-chip').click()
  await expect(page).toHaveURL(/\/memory#m-/)
  await expect(page.locator('[data-testid=memory-item][data-focused]')).toContainText('My dog is called Juniper.')
})

test("nobody can save from or undo in someone else's chat", async ({ page, baseURL, browser }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'My dog is called Juniper.')
  await expect(page.getByTestId('memory-saved')).toHaveCount(1, { timeout: 20_000 })
  const chatId = chatIdFrom(page.url())
  const chat = await (await page.request.get(`/api/chats/${chatId}`)).json()
  const userMessage = chat.messages[0]
  const saveId = userMessage.memory.saves[0].id

  const other = await browser.newContext({ baseURL })
  const stranger = other.request
  await stranger.get(await requestLink(stranger, baseURL!, newEmail('stranger')))
  const save = await stranger.post(`/api/chats/${chatId}/messages/${userMessage.id}/save`)
  expect(save.status()).toBe(404)
  expect((await save.json()).error).toBe('chat_not_found')
  const undo = await stranger.post(`/api/chats/${chatId}/saves/${saveId}/undo`)
  expect(undo.status()).toBe(404)
  expect((await undo.json()).error).toBe('memory_not_found')
  await other.close()

  // Still there for its owner.
  expect((await (await page.request.get('/api/memory')).json()).memories).toHaveLength(1)
})
