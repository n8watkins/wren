import { describe, expect, it } from 'vitest'
import { MemoryAiError, MemoryEngine, cleanFacts, documentText, type FileStore, type MemoryAi } from '../../agent/memory'
import { insertMemory, listMemories } from '../../agent/memory-store'
import { sqliteStore, vectorizeStore, type VectorIndex, type VectorStore } from '../../agent/memory-vectors'
import { MEMORY_LIMITS } from '../../lib/memory'
import { mockEmbedding } from '../mocks/embedding.mjs'
import { memorySql } from '../support/sql'

/** A stand-in for Gemini: the mock embeddings, and a scripted JSON reply. */
function fakeAi(options: { facts?: string[]; failWith?: string; pdfText?: string } = {}) {
  const calls: { kind: 'embed' | 'json'; text: string }[] = []
  const ai: MemoryAi = {
    async embed(text) {
      calls.push({ kind: 'embed', text })
      if (options.failWith) throw new MemoryAiError(options.failWith as never)
      return mockEmbedding(text)
    },
    async json(request) {
      const text = request.parts.map((p) => ('text' in p ? p.text : `[${p.inlineData.mimeType}]`)).join('\n')
      calls.push({ kind: 'json', text })
      if (options.failWith) throw new MemoryAiError(options.failWith as never)
      if (text.includes('[application/pdf]')) return { text: options.pdfText ?? 'Text from the PDF.' }
      return { facts: options.facts ?? [] }
    },
  }
  return { ai, calls }
}

/** A stand-in for a Vectorize index: one shared store, kept apart by namespace like the real one. */
function fakeIndex() {
  const vectors = new Map<string, { values: number[]; namespace?: string }>()
  const seen: { op: string; namespace?: string }[] = []
  const index: VectorIndex = {
    async upsert(list) {
      for (const v of list) {
        seen.push({ op: 'upsert', namespace: v.namespace })
        vectors.set(v.id, { values: v.values, namespace: v.namespace })
      }
    },
    async query(vector, options) {
      seen.push({ op: 'query', namespace: options.namespace })
      const dot = (a: number[], b: number[]) => a.reduce((n, x, i) => n + x * b[i], 0)
      return {
        matches: [...vectors.entries()]
          .filter(([, v]) => v.namespace === options.namespace)
          .map(([id, v]) => ({ id, score: dot(vector, v.values) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, options.topK ?? 5),
      }
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id)
    },
  }
  return { index, vectors, seen }
}

function fakeFiles() {
  const objects = new Map<string, ArrayBuffer>()
  const files: FileStore = {
    async put(key, value) {
      objects.set(key, value)
    },
    async get(key) {
      const value = objects.get(key)
      return value ? { arrayBuffer: async () => value } : null
    },
    async delete(key) {
      objects.delete(key)
    },
  }
  return { files, objects }
}

const PREFIX = 'a'.repeat(64)

function engine(options: { ai?: MemoryAi; vectors?: VectorStore; prefix?: string } = {}) {
  const sql = memorySql()
  const { files, objects } = fakeFiles()
  const vectors = options.vectors ?? sqliteStore(sql)
  const memory = new MemoryEngine({ sql, vectors, files, filePrefix: options.prefix ?? PREFIX, ai: options.ai ?? fakeAi().ai })
  return { memory, sql, objects, vectors }
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('memory store', () => {
  it('saves notes and links, newest first, searchable by meaning', async () => {
    const { memory } = engine()
    const note = await memory.addNote('Heat pump sizing for the old house')
    expect(note).toMatchObject({ ok: true, memory: { kind: 'note', origin: 'you', indexed: true } })
    const link = await memory.addLink('https://example.com/risotto', 'Weeknight risotto')
    expect(link.ok && link.memory.url).toBe('https://example.com/risotto')
    const all = await memory.list()
    expect(all.memories.map((m) => m.kind)).toEqual(['link', 'note'])
    expect(all.usage).toMatchObject({ count: 2, limit: MEMORY_LIMITS.count, bytes: 0 })
  })

  it('finds by words first, then by meaning, and filters by kind', async () => {
    const { memory } = engine()
    await memory.addNote('Heat pump sizing')
    await memory.addNote('Arborio rice for risotto')
    await memory.addLink('https://example.com/a', 'Pumps compared')
    const words = await memory.list({ query: 'risotto' })
    expect(words.memories.map((m) => m.text)).toEqual(['Arborio rice for risotto'])
    // "pumps" isn't a word in "Heat pump sizing", but it means the same.
    const meaning = await memory.list({ query: 'heat pumps' })
    expect(meaning.meaning).toBe(true)
    expect(meaning.memories.map((m) => m.text)).toEqual(['Heat pump sizing'])
    const links = await memory.list({ query: 'pumps', kind: 'link' })
    expect(links.memories.map((m) => m.title)).toEqual(['Pumps compared'])
  })

  it('stores hostile text as data, not SQL', async () => {
    const { memory } = engine()
    await memory.addNote("x'); DROP TABLE memories; --")
    const list = await memory.list({ query: "' OR 1=1 --" })
    expect(list.memories).toEqual([])
    expect((await memory.list()).memories[0].text).toBe("x'); DROP TABLE memories; --")
  })

  it('edits text, titles and links, and re-embeds them', async () => {
    const { memory } = engine()
    const saved = await memory.addLink('https://example.com/a', 'Old')
    if (!saved.ok) throw new Error('not saved')
    const edited = await memory.update(saved.memory.id, { title: 'New title', url: 'https://example.com/b' })
    expect(edited).toMatchObject({ ok: true, memory: { title: 'New title', url: 'https://example.com/b', indexed: true } })
    expect(await memory.update(crypto.randomUUID(), { text: 'x' })).toEqual({ ok: false, code: 'memory_not_found' })
    const note = await memory.addNote('Note')
    if (!note.ok) throw new Error('not saved')
    expect(await memory.update(note.memory.id, { text: '   ' })).toEqual({ ok: false, code: 'bad_request' })
  })
})

describe('memory caps', () => {
  it(`keeps at most ${MEMORY_LIMITS.count} memories`, async () => {
    const { memory, sql } = engine()
    for (let i = 0; i < MEMORY_LIMITS.count; i++) insertMemory(sql, { kind: 'note', text: `n${i}`, origin: 'you' })
    expect(await memory.addNote('one more')).toEqual({ ok: false, code: 'memory_full' })
    expect(await memory.addFile('a.txt', bytes('hello'))).toEqual({ ok: false, code: 'memory_full' })
    expect(memory.usage().count).toBe(MEMORY_LIMITS.count)
  })

  it('keeps at most 25 MB of files, 5 MB each, of the types it reads', async () => {
    const { memory, sql } = engine()
    insertMemory(sql, {
      kind: 'file',
      text: 'big',
      origin: 'you',
      file: { key: 'k', name: 'big.txt', size: MEMORY_LIMITS.fileBytes - 10, type: 'text/plain' },
    })
    expect(await memory.addFile('a.txt', bytes('more than ten bytes'))).toEqual({ ok: false, code: 'memory_files_full' })
    expect(await memory.addFile('a.txt', new ArrayBuffer(MEMORY_LIMITS.fileMaxBytes + 1))).toEqual({
      ok: false,
      code: 'memory_file_too_large',
    })
    expect(await memory.addFile('a.exe', bytes('MZ'))).toEqual({ ok: false, code: 'memory_file_type' })
    expect(await memory.addFile('a.html', bytes('<script>'))).toEqual({ ok: false, code: 'memory_file_type' })
  })

  it('reads text and Markdown files, rejects ones that are not text, and asks Gemini to read a PDF', async () => {
    const { ai, calls } = fakeAi({ pdfText: 'Quarterly heat bills' })
    const { memory, objects } = engine({ ai })
    const md = await memory.addFile('notes/plan.md', bytes('# Plan\n\nInsulate the attic first.'))
    expect(md).toMatchObject({ ok: true, memory: { kind: 'file', title: 'plan.md', file: { name: 'plan.md', type: 'text/markdown' } } })
    expect(objects.size).toBe(1)
    expect([...objects.keys()][0]).toMatch(new RegExp(`^${PREFIX}/[0-9a-f-]{36}$`))
    expect(await memory.addFile('bad.txt', new Uint8Array([0xff, 0xfe, 0xfd]).buffer)).toEqual({
      ok: false,
      code: 'memory_file_unreadable',
    })
    expect(await memory.addFile('fake.pdf', bytes('not a pdf'))).toEqual({ ok: false, code: 'memory_file_unreadable' })
    const pdf = await memory.addFile('bills.pdf', bytes('%PDF-1.4 ...'))
    expect(pdf).toMatchObject({ ok: true, memory: { text: 'Quarterly heat bills', file: { type: 'application/pdf' } } })
    expect(calls.some((c) => c.kind === 'json' && c.text.includes('[application/pdf]'))).toBe(true)
    expect(memory.usage().bytes).toBe(md.ok && pdf.ok ? md.memory.file!.size + pdf.memory.file!.size : -1)
  })

  it('shows a long file as an excerpt in lists', async () => {
    const { memory } = engine()
    await memory.addFile('long.txt', bytes('word '.repeat(2000)))
    const [file] = (await memory.list()).memories
    expect(file.text.length).toBeLessThanOrEqual(MEMORY_LIMITS.excerptChars + 1)
  })
})

describe('memory without Gemini', () => {
  it('still saves, finds by words, and embeds it on a later save', async () => {
    const down = fakeAi({ failWith: 'demo_unavailable' })
    const { memory, sql, vectors } = engine({ ai: down.ai })
    const saved = await memory.addNote('Saved while the key was missing')
    expect(saved).toMatchObject({ ok: true, memory: { indexed: false } })
    expect((await memory.list({ query: 'missing' })).memories).toHaveLength(1)
    expect((await memory.list({ query: 'missing' })).meaning).toBe(false)

    const later = new MemoryEngine({ sql, vectors, files: fakeFiles().files, filePrefix: PREFIX, ai: fakeAi().ai })
    await later.addNote('Now the key works')
    expect(listMemories(sql).every((m) => m.indexed)).toBe(true)
  })

  it('a rejected personal key saves nothing and is shown', async () => {
    const { memory, sql } = engine({ ai: fakeAi({ failWith: 'user_key_invalid' }).ai })
    expect(await memory.addNote('x')).toEqual({ ok: false, code: 'user_key_invalid' })
    expect(memory.usage().count).toBe(0)
    insertMemory(sql, { kind: 'note', text: 'saved earlier', origin: 'you' })
    expect((await memory.list({ query: 'anything' })).notice).toBe('user_key_invalid')
  })

  it('a PDF needs Gemini to read it', async () => {
    const { memory } = engine({ ai: fakeAi({ failWith: 'memory_daily_limit' }).ai })
    expect(await memory.addFile('a.pdf', bytes('%PDF-1.7'))).toEqual({ ok: false, code: 'memory_daily_limit' })
  })
})

describe('deleting a memory', () => {
  it('removes its row, its search vector and its file', async () => {
    const { index, vectors } = fakeIndex()
    const { memory, objects } = engine({ vectors: vectorizeStore(index, PREFIX) })
    const saved = await memory.addFile('plan.txt', bytes('Insulate the attic'))
    if (!saved.ok) throw new Error('not saved')
    expect(vectors.has(saved.memory.id)).toBe(true)
    expect(objects.size).toBe(1)
    expect(await memory.remove(saved.memory.id)).toBe(true)
    expect(vectors.has(saved.memory.id)).toBe(false)
    expect(objects.size).toBe(0)
    expect(memory.get(saved.memory.id)).toBeNull()
    expect(await memory.remove(saved.memory.id)).toBe(false)
  })

  it('keeps the memory when its file or vector could not be deleted, so it can be tried again', async () => {
    const { memory, sql } = engine({
      vectors: { upsert: async () => undefined, query: async () => [], remove: async () => Promise.reject(new Error('down')) },
    })
    const saved = await memory.addNote('Stays until it is really gone')
    if (!saved.ok) throw new Error('not saved')
    await expect(memory.remove(saved.memory.id)).rejects.toThrow('down')
    expect(listMemories(sql)).toHaveLength(1)
  })
})

describe('namespaces', () => {
  it("one person's search never returns another person's memory", async () => {
    const shared = fakeIndex()
    const a = engine({ vectors: vectorizeStore(shared.index, 'a'.repeat(64)) })
    const b = engine({ vectors: vectorizeStore(shared.index, 'b'.repeat(64)), prefix: 'b'.repeat(64) })
    await b.memory.addNote('Secret heat pump plans')
    await a.memory.addNote('Garden notes')
    // B's vector is the closest one in the shared index, but it is in B's namespace.
    const found = await a.memory.list({ query: 'secret heat pump plans' })
    expect(found.meaning).toBe(true)
    expect(found.memories).toEqual([])
    expect((await b.memory.list({ query: 'heat pumps' })).memories).toHaveLength(1)
    expect(shared.seen.length).toBeGreaterThan(0)
    expect(shared.seen.every((call) => call.namespace === 'a'.repeat(64) || call.namespace === 'b'.repeat(64))).toBe(true)
  })

  it('refuses a namespace that is not an agent id', () => {
    const { index } = fakeIndex()
    for (const bad of ['', 'x'.repeat(10), '../other', 'a'.repeat(65)]) expect(() => vectorizeStore(index, bad)).toThrow()
  })
})

describe('the extractor', () => {
  const said = (...texts: string[]) => texts.map((text, i) => ({ id: `m${i}`, text }))

  it('saves at most 3 lasting facts as Wren’s, with where they came from', async () => {
    const { ai } = fakeAi({ facts: ['Prefers vegetarian recipes.', 'Is renovating a 1960s house.', 'Rides an e-bike.', 'Fourth.'] })
    const { memory } = engine({ ai })
    const saved = await memory.rememberFacts(said('I only eat vegetarian food.'), { chatId: 'c1' })
    expect(saved.map((s) => s.action)).toEqual(['added', 'added', 'added'])
    expect(saved[0].memory).toMatchObject({ kind: 'fact', origin: 'wren', sourceChatId: 'c1', sourceMessageId: 'm0', indexed: true })
  })

  it('reads only the messages it is given, the newest few', async () => {
    const { ai, calls } = fakeAi({ facts: [] })
    const { memory } = engine({ ai })
    await memory.rememberFacts(said('one', 'two', 'three', 'four', 'five', ''))
    const prompt = calls.find((c) => c.kind === 'json')?.text ?? ''
    expect(prompt).not.toContain('one')
    expect(prompt).toContain('five')
    expect(prompt.match(/Message \d+:/g)).toHaveLength(MEMORY_LIMITS.extractorMessages)
    expect(await memory.rememberFacts([])).toEqual([])
  })

  it('updates a near-duplicate fact instead of adding a second copy', async () => {
    const first = fakeAi({ facts: ['Prefers vegetarian recipes'] })
    const { memory, sql, vectors } = engine({ ai: first.ai })
    await memory.rememberFacts(said('I am vegetarian'))
    const again = new MemoryEngine({
      sql,
      vectors,
      files: fakeFiles().files,
      filePrefix: PREFIX,
      ai: fakeAi({ facts: ['Prefers vegetarian recipe', 'prefers vegetarian recipes!'] }).ai,
    })
    const saved = await again.rememberFacts(said('Still vegetarian'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ action: 'updated', previousText: 'Prefers vegetarian recipes', memory: { text: 'Prefers vegetarian recipe' } })
    expect(listMemories(sql)).toHaveLength(1)
  })

  it('leaves a note the person wrote alone when a fact repeats it', async () => {
    const { memory, sql } = engine({ ai: fakeAi({ facts: ['Prefers vegetarian recipes'] }).ai })
    await memory.addNote('Prefers vegetarian recipes')
    expect(await memory.rememberFacts(said('I am vegetarian'))).toEqual([])
    expect(listMemories(sql).map((m) => m.kind)).toEqual(['note'])
  })

  it('saves nothing when Gemini fails or memory is full', async () => {
    const { memory } = engine({ ai: fakeAi({ failWith: 'upstream_error' }).ai })
    expect(await memory.rememberFacts(said('I like tea'))).toEqual([])
    const full = engine({ ai: fakeAi({ facts: ['Likes tea.'] }).ai })
    for (let i = 0; i < MEMORY_LIMITS.count; i++) insertMemory(full.sql, { kind: 'note', text: `n${i}`, origin: 'you' })
    expect(await full.memory.rememberFacts(said('I like tea'))).toEqual([])
  })

  it('keeps only clean, short, distinct facts from the reply', () => {
    expect(cleanFacts(null)).toEqual([])
    expect(cleanFacts({ facts: 'not a list' })).toEqual([])
    expect(cleanFacts({ facts: [' A  b ', 'a b', 3, '', 'x'.repeat(400)] })).toEqual(['A b', 'x'.repeat(MEMORY_LIMITS.factChars)])
  })
})

describe('embedding text', () => {
  it('uses the retrieval format and stays under the input limit', () => {
    expect(documentText({ kind: 'link', title: 'T', text: 'd', url: 'https://x.test/', file: null })).toBe('title: T | text: https://x.test/\nd')
    expect(documentText({ kind: 'note', title: '', text: 'x'.repeat(10_000), url: null, file: null }).length).toBe(6_000)
  })
})
