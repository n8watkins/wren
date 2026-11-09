import { expect, test } from './fixtures'
import { composer, isPhone, meterChat, noHorizontalScroll, sendMessage, signIn } from './helpers'

test('chat round trip: stream, save, list, reload', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await expect(await meterChat(page)).toHaveText('0/50')
  if (isPhone(page)) await page.getByTestId('title-menu').click()

  await sendMessage(page, 'Hello Wren')
  const answer = page.getByTestId('answer').last()
  await expect(answer).toContainText('You said: "Hello Wren". This is turn 1 of our chat.')
  await expect(answer.locator('strong')).toHaveText('chat')
  await expect(answer).toHaveAttribute('data-status', 'done')
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
  await expect(await meterChat(page)).toHaveText('1/50')
  if (isPhone(page)) await page.getByTestId('title-menu').click()

  await sendMessage(page, 'And again')
  await expect(page.getByTestId('answer').last()).toContainText('turn 2 of our chat')

  await page.reload()
  await expect(page.getByTestId('user-message')).toHaveText(['Hello Wren', 'And again'])
  await expect(page.getByTestId('answer')).toHaveCount(2)
  if (isPhone(page)) {
    await expect(page.getByTestId('title-menu')).toContainText('Hello Wren')
    await page.getByTestId('title-menu').click()
  } else {
    await expect(page.getByTestId('title')).toHaveText('Hello Wren')
  }
  await expect(page.locator(isPhone(page) ? '.mmenu' : '.side').getByTestId('recent-chat')).toHaveText(['Hello Wren'])
  await noHorizontalScroll(page)
})

test('regenerate replaces the last answer', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'Regenerate me')
  await expect(page.getByTestId('answer')).toHaveCount(1)
  await expect(page.getByTestId('answer')).toHaveAttribute('data-status', 'done')
  await page.getByTestId('regenerate').click()
  await expect(page.getByTestId('answer')).toHaveCount(1)
  await expect(page.getByTestId('answer')).toContainText('Regenerate me')
  await expect(page.getByTestId('answer')).toHaveAttribute('data-status', 'done')
  await page.reload()
  await expect(page.getByTestId('answer')).toHaveCount(1)
  await expect(page.getByTestId('user-message')).toHaveCount(1)
})

test('stop ends the answer and keeps what was written', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'mock:slow please')
  await expect(page.getByTestId('answer')).toContainText('word2')
  await page.locator(isPhone(page) ? '.mcomp' : '.composer').getByTestId('stop').click()
  const answer = page.getByTestId('answer').last()
  await expect(answer).toHaveAttribute('data-status', 'stopped')
  await expect(answer).toContainText('Stopped')
  const kept = await answer.locator('.md').innerText()
  await page.waitForTimeout(800)
  expect(await answer.locator('.md').innerText()).toBe(kept)
  await page.reload()
  await expect(page.getByTestId('answer').last()).toHaveAttribute('data-status', 'stopped')
  expect(await page.getByTestId('answer').last().locator('.md').innerText()).not.toContain('word39')
})

test('hostile model output renders as text, never as HTML', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'mock:xss')
  const answer = page.getByTestId('answer').last()
  await expect(answer.locator('strong')).toHaveText('bold')
  await expect(answer).toHaveAttribute('data-status', 'done')
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  await expect(answer.locator('img, script, iframe')).toHaveCount(0)
  await expect(answer.locator('a[href^="javascript"]')).toHaveCount(0)
  await expect(answer.locator('a[href="https://example.com"]')).toHaveAttribute('rel', /noopener/)
})

test('your own key: saved in this browser, and a rejected key is shown, not swapped', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await page.getByTestId(isPhone(page) ? 'title-menu' : 'key-pill').click()
  if (isPhone(page)) await page.locator('.mmenu .row').getByRole('button', { name: 'Use your key' }).click()
  const dialog = page.getByTestId('key-dialog')
  await dialog.getByLabel('Gemini API key').fill('bad-key-0123456789abcdefghij')
  await dialog.getByRole('button', { name: 'Save key' }).click()
  await expect(dialog).toBeHidden()
  if (!isPhone(page)) await expect(page.getByTestId('key-pill')).toHaveText('Your key is on')

  await sendMessage(page, 'Hello with my key')
  await expect(page.getByTestId('chat-error').filter({ visible: true })).toContainText('Gemini rejected your API key')
  await expect(page.getByTestId('answer')).toHaveCount(0)
  const stored = await page.evaluate(() => localStorage.getItem('wren:gemini-key'))
  expect(stored).toBe('bad-key-0123456789abcdefghij')
})

test('deleting a chat removes it', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await sendMessage(page, 'Delete this one')
  await expect(page.getByTestId('answer')).toHaveAttribute('data-status', 'done')
  if (isPhone(page)) await page.getByTestId('title-menu').click()
  const list = page.locator(isPhone(page) ? '.mmenu' : '.side')
  await list.getByRole('button', { name: 'Delete "Delete this one"' }).click()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(list.getByTestId('recent-chat')).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
  await expect(composer(page)).toBeVisible()
})
