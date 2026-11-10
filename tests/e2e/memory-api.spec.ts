import { request as requests, type APIRequestContext } from '@playwright/test'
import { expect, randomIp, test } from './fixtures'
import { newEmail, requestLink } from './helpers'

/** Memory's API as an attacker sees it: no session, someone else's session, hostile bodies and files. */

const MEMORY_ROUTES: [string, string][] = [
  ['GET', '/api/memory'],
  ['POST', '/api/memory'],
  ['POST', '/api/memory/files'],
  ['PATCH', '/api/memory/00000000-0000-4000-8000-000000000000'],
  ['DELETE', '/api/memory/00000000-0000-4000-8000-000000000000'],
  ['GET', '/api/memory/00000000-0000-4000-8000-000000000000/file'],
]

for (const [method, path] of MEMORY_ROUTES) {
  test(`${method} ${path} needs a session`, async ({ request }) => {
    const response = await request.fetch(path, { method, data: method === 'GET' || method === 'DELETE' ? undefined : { kind: 'note', text: 'hi' } })
    expect(response.status()).toBe(401)
    expect((await response.json()).error).toBe('unauthorized')
  })
}

test('a guest gets no memory', async ({ request }) => {
  expect((await request.post('/api/guest/start', { data: { token: 'test-ok' } })).ok()).toBe(true)
  expect((await request.get('/api/memory')).status()).toBe(401)
})

async function person(playwright: { request: typeof requests }, baseURL: string, tag: string): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'cf-connecting-ip': randomIp() } })
  await context.get(await requestLink(context, baseURL, newEmail(tag)))
  return context
}

const upload = (me: APIRequestContext, name: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  me.post('/api/memory/files', { data: body, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...headers } })

test('one person cannot find, read, edit or delete another person’s memory', async ({ playwright, baseURL }) => {
  const alice = await person(playwright, baseURL!, 'alice')
  const bob = await person(playwright, baseURL!, 'bob')

  const note = await alice.post('/api/memory', { data: { kind: 'note', text: 'Alice’s secret heat pump plan' } })
  expect(note.status()).toBe(201)
  const id = (await note.json()).memory.id as string
  const file = await upload(alice, 'plan.md', '# Secret plan')
  expect(file.status()).toBe(201)
  const fileId = (await file.json()).memory.id as string

  // Bob's library and his searches (by words and by meaning) never include Alice's.
  await bob.post('/api/memory', { data: { kind: 'note', text: 'Bob’s garden' } })
  for (const q of ['secret', 'heat pump plan', 'secret plan']) {
    const found = await (await bob.get(`/api/memory?q=${encodeURIComponent(q)}`)).json()
    expect(JSON.stringify(found)).not.toContain('Alice')
    expect(found.memories.map((m: { id: string }) => m.id)).not.toContain(id)
  }
  expect((await bob.patch(`/api/memory/${id}`, { data: { text: 'Bob was here' } })).status()).toBe(404)
  expect((await bob.delete(`/api/memory/${id}`)).status()).toBe(404)
  expect((await bob.get(`/api/memory/${fileId}/file`)).status()).toBe(404)
  // Naming someone in the body is refused outright.
  expect((await bob.post('/api/memory', { data: { kind: 'note', text: 'x', userId: id } })).status()).toBe(400)

  const mine = await (await alice.get('/api/memory?q=secret%20heat%20pumps')).json()
  expect(mine.memories.map((m: { text: string }) => m.text)).toContain('Alice’s secret heat pump plan')
  expect(mine.meaning).toBe(true)
  await alice.dispose()
  await bob.dispose()
})

test('hostile memory requests and files are refused', async ({ playwright, baseURL }) => {
  const me = await person(playwright, baseURL!, 'hostile')
  for (const data of [
    { kind: 'link', url: 'javascript:alert(1)' },
    { kind: 'link', url: 'file:///etc/passwd' },
    { kind: 'fact', text: 'only Wren saves facts' },
    { kind: 'note', text: 'x', origin: 'wren' },
    { kind: 'note', text: 'x'.repeat(4_001) },
  ]) {
    expect((await me.post('/api/memory', { data })).status(), JSON.stringify(data).slice(0, 40)).toBe(400)
  }
  expect((await me.get('/api/memory?kind=secret')).status()).toBe(400)
  expect((await me.delete("/api/memory/' OR 1=1 --")).status()).toBe(404)
  expect((await upload(me, 'page.html', '<script>alert(1)</script>')).status()).toBe(415)
  expect((await upload(me, 'fake.pdf', 'not a pdf')).status()).toBe(422)
  expect((await upload(me, 'big.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 97))).status()).toBe(413)
  expect((await upload(me, '', 'x')).status()).toBe(400)

  // A saved file comes back only as a download, never rendered.
  const saved = await upload(me, 'notes.txt', 'plain <b>text</b>')
  const id = (await saved.json()).memory.id as string
  const download = await me.get(`/api/memory/${id}/file`)
  expect(download.status()).toBe(200)
  expect(download.headers()['content-disposition']).toBe("attachment; filename*=UTF-8''notes.txt")
  expect(download.headers()['content-type']).toBe('text/plain; charset=utf-8')
  expect(download.headers()['x-content-type-options']).toBe('nosniff')
  expect(await download.text()).toBe('plain <b>text</b>')
  await me.dispose()
})

test('a PDF is read by Gemini, and deleting a file removes it', async ({ playwright, baseURL }) => {
  const me = await person(playwright, baseURL!, 'pdf')
  const pdf = '%PDF-1.4\n1 0 obj << >> endobj\nBT (Quarterly heat bills) Tj ET\n%%EOF'
  const saved = await upload(me, 'bills.pdf', pdf)
  expect(saved.status()).toBe(201)
  const memory = (await saved.json()).memory
  expect(memory).toMatchObject({ kind: 'file', text: 'Quarterly heat bills', file: { type: 'application/pdf', name: 'bills.pdf' } })
  const list = await (await me.get('/api/memory')).json()
  expect(list.usage).toMatchObject({ count: 1, limit: 500, bytes: pdf.length, byteLimit: 25 * 1024 * 1024 })

  expect((await me.delete(`/api/memory/${memory.id}`)).status()).toBe(200)
  expect((await me.get(`/api/memory/${memory.id}/file`)).status()).toBe(404)
  expect((await (await me.get('/api/memory')).json()).usage).toMatchObject({ count: 0, bytes: 0 })
  await me.dispose()
})

test('a rejected personal key saves nothing and says so', async ({ playwright, baseURL }) => {
  const me = await person(playwright, baseURL!, 'badkey')
  const response = await me.post('/api/memory', {
    data: { kind: 'note', text: 'hello' },
    headers: { 'x-gemini-key': 'bad-key-0123456789abcdefghij' },
  })
  expect(response.status()).toBe(400)
  expect((await response.json()).error).toBe('user_key_invalid')
  expect((await (await me.get('/api/memory')).json()).usage.count).toBe(0)
  await me.dispose()
})
