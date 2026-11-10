import { expect, test } from './fixtures'
import { isPhone, noHorizontalScroll, signIn } from './helpers'

/** The Memory page, as a person uses it, at desktop and phone widths. */

test('add a note, a link and a file, find them by words and meaning, edit and delete', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await page.goto('/memory')
  const memory = page.getByTestId('memory-page')
  await expect(memory.getByTestId('memory-empty')).toContainText('Nothing saved yet')
  await expect(memory.getByTestId('memory-usage-count')).toHaveText('0 of 500 memories')
  await expect(memory.getByTestId('memory-usage-bytes')).toHaveText('0 bytes of 25 MB in files')
  await noHorizontalScroll(page)

  // A note.
  await memory.getByTestId('memory-add-note').click()
  await memory.getByTestId('memory-note-text').fill('Heat pump sizing for the 1960s house')
  await memory.getByTestId('memory-save').click()
  await expect(memory.getByTestId('memory-add-form')).toBeHidden()
  await expect(memory.getByTestId('memory-item')).toHaveCount(1)

  // A link, typed without https://.
  await memory.getByTestId('memory-add-link').click()
  await memory.getByTestId('memory-link-url').fill('example.com/risotto')
  await memory.getByTestId('memory-link-title').fill('Weeknight risotto')
  await memory.getByTestId('memory-save').click()
  const link = memory.getByTestId('memory-item').filter({ hasText: 'Weeknight risotto' })
  await expect(link.getByRole('link', { name: 'Weeknight risotto' })).toHaveAttribute('href', 'https://example.com/risotto')

  // A Markdown file.
  await memory.getByTestId('memory-add-file').click()
  await memory.getByTestId('memory-file-input').setInputFiles({
    name: 'attic.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Attic\n\nInsulate the attic before winter.'),
  })
  const file = memory.getByTestId('memory-item').filter({ hasText: 'attic.md' })
  await expect(file).toContainText('Attic: Insulate the attic before winter.')
  await expect(memory.getByTestId('memory-item')).toHaveCount(3)
  await expect(memory.getByTestId('memory-usage-count')).toHaveText('3 of 500 memories')
  await expect(memory.getByTestId('memory-usage-bytes')).toHaveText('42 bytes of 25 MB in files')

  // Filter by kind.
  await memory.getByTestId('memory-filter-link').click()
  await expect(memory.getByTestId('memory-item')).toHaveCount(1)
  await expect(memory.getByTestId('memory-filter-link')).toContainText('1')
  await memory.getByTestId('memory-filter-all').click()
  await expect(memory.getByTestId('memory-item')).toHaveCount(3)

  // Words match at once; "heat pumps" isn't in the note's words, but it means the same.
  const search = memory.getByTestId('memory-search')
  await search.fill('risotto')
  await expect(memory.getByTestId('memory-item')).toHaveCount(1)
  await search.fill('heat pumps')
  await expect(memory.getByTestId('memory-item')).toHaveCount(1)
  await expect(memory.getByTestId('memory-item')).toContainText('Heat pump sizing')
  await expect(memory.getByText('Related by meaning')).toBeVisible()
  await search.fill('nothing like this anywhere')
  // A search by meaning goes to the server after a pause in typing; under a full parallel run it can take over 5 s.
  await expect(memory.getByTestId('memory-none')).toContainText('Nothing matches', { timeout: 15_000 })
  await search.fill('')
  await noHorizontalScroll(page)

  // Edit the note in place.
  const note = memory.getByTestId('memory-item').filter({ hasText: 'Heat pump sizing' })
  await note.getByTestId('memory-edit').click()
  const editor = memory.getByTestId('memory-edit-text')
  await expect(editor).toHaveValue('Heat pump sizing for the 1960s house')
  await editor.fill('Heat pump: 3.5 tons for the 1960s house')
  await memory.getByTestId('memory-edit-save').click()
  await expect(memory.getByTestId('memory-item').filter({ hasText: '3.5 tons' })).toHaveCount(1)

  // Delete asks first, on the item itself; "Keep it" keeps it.
  await file.getByTestId('memory-delete').click()
  await expect(file.getByTestId('memory-confirm')).toContainText('Delete for good?')
  await file.getByRole('button', { name: 'Keep it' }).click()
  await expect(file.getByTestId('memory-confirm')).toBeHidden()
  await file.getByTestId('memory-delete').click()
  await file.getByTestId('memory-confirm-delete').click()
  await expect(memory.getByTestId('memory-item')).toHaveCount(2)
  await expect(memory.getByTestId('memory-usage-bytes')).toHaveText('0 bytes of 25 MB in files')

  // It all comes back after a reload, from the person's own agent.
  await page.reload()
  await expect(page.getByTestId('memory-item')).toHaveCount(2)
  await expect(page.getByTestId('memory-usage-count')).toHaveText('2 of 500 memories')
})

test('the sidebar "+" opens a new note from any page', async ({ page, baseURL }) => {
  test.skip(isPhone(page), 'a phone has no sidebar; the page has its own add buttons')
  await signIn(page, baseURL!)
  await page.locator('.side [data-tip="mem"]').click()
  await expect(page).toHaveURL(/\/memory$/)
  await expect(page.getByTestId('memory-note-text')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('memory-add-form')).toBeHidden()
})

test('a file Memory does not read is refused with a clear message', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await page.goto('/memory')
  await page.getByTestId('memory-add-file').click()
  await page.getByTestId('memory-file-input').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<p>hi</p>') })
  await expect(page.getByTestId('memory-add-form').getByRole('alert')).toHaveText('Memory reads text, Markdown and PDF files.')
  await expect(page.getByTestId('memory-empty')).toBeVisible()
})
