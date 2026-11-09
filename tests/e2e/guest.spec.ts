import { expect, test } from './fixtures'
import { composer, isPhone, meterChat, noHorizontalScroll, sendMessage, skipIntro } from './helpers'

/** A guest in the browser: the human check, a chat that lives in the tab, and the limit. */

test('a guest chats after the human check; the chat stays in this tab only', async ({ page, context }) => {
  await skipIntro(page)
  await page.goto('/')
  await expect(page.getByTestId('guest-intro')).toContainText('5 messages today')
  await expect(page.getByTestId('guest-intro')).toContainText('Sign in for 10x more messages, voice, research and memory')
  await expect(await meterChat(page)).toHaveText('0/5')
  if (isPhone(page)) await page.getByTestId('title-menu').click()

  await sendMessage(page, 'Hello from a guest')
  const answer = page.getByTestId('answer').last()
  await expect(answer).toContainText('You said: "Hello from a guest"', { timeout: 20_000 })
  await expect(answer).toHaveAttribute('data-status', 'done')
  await expect(page).toHaveURL(/\/$/)
  await expect(await meterChat(page)).toHaveText('1/5')
  if (isPhone(page)) await page.getByTestId('title-menu').click()

  await sendMessage(page, 'Second one')
  await expect(page.getByTestId('answer').last()).toContainText('turn 2 of our chat')

  // Kept in this tab across a reload...
  await page.reload()
  await expect(page.getByTestId('user-message')).toHaveText(['Hello from a guest', 'Second one'])
  // ...and nowhere else: not in a new tab, not in localStorage, not on the server.
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.getByTestId('welcome')).toBeVisible()
  expect(await other.evaluate(() => JSON.stringify(localStorage))).not.toContain('Hello from a guest')
  expect((await page.request.get('/api/chats')).status()).toBe(401)
  await noHorizontalScroll(page)
})

test('after five messages a guest is offered sign-in', async ({ page }) => {
  await skipIntro(page)
  await page.goto('/')
  await sendMessage(page, 'One')
  await expect(page.getByTestId('answer')).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  // The tab's guest cookie is shared with page.request: use up the rest quickly.
  for (let i = 0; i < 4; i++) {
    const quick = await page.request.post('/api/guest/chat', { data: { text: `quick ${i}`, history: [] } })
    expect(quick.status(), await quick.text()).toBe(200)
  }
  await composer(page).fill('One too many')
  await page.locator(isPhone(page) ? '.mcomp' : '.composer').getByTestId('send').click()
  const alert = page.getByTestId('chat-error').filter({ visible: true })
  await expect(alert).toContainText('You’ve used today’s 5 guest messages. Sign in for 10x more messages, voice, research and memory.')
  await alert.getByTestId('error-sign-in').click()
  await expect(page.getByTestId('sign-in')).toBeVisible()
})
