import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createModelCheckTable, probesFor, readModelCheck, runProbes, saveModelCheck, type Probe } from '../../agent/model-check'
import { GeminiError } from '../../agent/gemini'
import { MODEL_CHECK_FRESH_MS, modelsHealth, type ModelCheckRun } from '../../lib/model-check'
import { memorySql } from '../support/sql'

// A fake Gemini API and Tavily on one port. The model name decides Gemini's
// answer: "ok-*" answers, "down-*" fails with 500, "silent-*" never answers,
// "empty-*" answers with no text, "nosrc-*" searches but finds nothing;
// "embed-768" embeds at 768 dimensions and "embed-3" at the wrong size.
// Tavily: the key "spent" is out of credits (432), anything else finds one page.
const seen: { path: string; body: Record<string, unknown>; key?: string }[] = []
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      const path = req.url ?? ''
      seen.push({ path, body, key: String(req.headers['x-goog-api-key'] ?? req.headers.authorization ?? '') })
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (path === '/search') {
        if (req.headers.authorization === 'Bearer spent') return json(432, { detail: 'plan limit' })
        return json(200, { results: [{ url: 'https://example.com/', title: 'Example', content: 'x' }] })
      }
      const model = /models\/([^:]+):/.exec(path)?.[1] ?? ''
      if (path.includes(':batchEmbedContents')) {
        const size = model === 'embed-768' ? 768 : 3
        return json(200, { embeddings: [{ values: Array.from({ length: size }, () => 0.01) }] })
      }
      if (model.startsWith('silent-')) return
      if (model.startsWith('down-')) return json(500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } })
      const grounded = ((body.tools as unknown[]) ?? []).length > 0
      const text = model.startsWith('empty-') ? '' : 'ok'
      const chunks = grounded && !model.startsWith('nosrc-') ? [{ web: { uri: 'https://example.com/', title: 'Example' } }] : []
      return json(200, {
        candidates: [{ content: { role: 'model', parts: text ? [{ text }] : [] }, index: 0, groundingMetadata: { groundingChunks: chunks } }],
      })
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

function env(overrides: Record<string, string | undefined> = {}): CloudflareEnv {
  return {
    GEMINI_MODEL: 'ok-chat',
    GEMINI_FALLBACK_MODEL: 'ok-fallback',
    GEMINI_EMBEDDING_MODEL: 'embed-768',
    GEMINI_LIVE_MODEL: 'live-model',
    GEMINI_API_KEY: 'demo-key',
    GEMINI_BASE_URL: baseUrl,
    TAVILY_API_KEY: 'tavily-key',
    TAVILY_BASE_URL: baseUrl,
    ...overrides,
  } as unknown as CloudflareEnv
}

/** Every probe but Live, which needs the Workers runtime's WebSocket fetch (covered end to end in tests/e2e/model-check-api.spec.ts). */
function runWithoutLive(e: CloudflareEnv, timeoutMs?: number) {
  return runProbes(
    probesFor(e).filter((p) => p.name !== 'live'),
    { timeoutMs, retryDelayMs: 0 }
  )
}

describe('the daily model check', () => {
  it('calls each dependency once with a tiny request, and reports each as ok', async () => {
    seen.length = 0
    const run = await runWithoutLive(env())
    expect(Object.keys(run.results).sort()).toEqual(['chat', 'chatFallback', 'embedding', 'googleSearch', 'tavily'])
    for (const result of Object.values(run.results)) expect(result).toMatchObject({ ok: true })
    expect(run.results.chat?.target).toBe('ok-chat')
    expect(run.results.chatFallback?.target).toBe('ok-fallback')
    expect(seen).toHaveLength(5)
    const tavily = seen.find((call) => call.path === '/search')
    expect(tavily?.body).toMatchObject({ max_results: 1, include_raw_content: false, search_depth: 'basic' })
    // Each model is called on its own: the fallback is never used to hide a failing primary.
    expect(seen.filter((call) => /ok-chat:generateContent/.test(call.path))).toHaveLength(2)
    expect(seen.filter((call) => /ok-fallback:generateContent/.test(call.path))).toHaveLength(1)
  })

  it('tries a failed call once more, so a one-off blip does not hold health red for a day', async () => {
    let tries = 0
    const flaky: Probe = {
      name: 'chat',
      target: 'm',
      run: async () => {
        tries++
        if (tries === 1) throw new GeminiError('upstream_error', 503)
      },
    }
    const run = await runProbes([flaky], { retryDelayMs: 0 })
    expect(tries).toBe(2)
    expect(run.results.chat).toEqual({ target: 'm', ok: true, ms: expect.any(Number), attempts: 2 })
  })

  it('calls a dependency that answers the first time only once', async () => {
    let tries = 0
    const run = await runProbes([{ name: 'chat', target: 'm', run: async () => void tries++ }])
    expect(tries).toBe(1)
    expect(run.results.chat).toEqual({ target: 'm', ok: true, ms: expect.any(Number) })
  })

  it('includes a Live probe for the configured model', () => {
    const live = probesFor(env()).find((p) => p.name === 'live')
    expect(live).toMatchObject({ target: 'live-model', skip: undefined })
  })

  it('reports a failing model with a short code and status, without trying the fallback in its place', async () => {
    const run = await runWithoutLive(env({ GEMINI_MODEL: 'down-chat' }))
    expect(run.results.chat).toMatchObject({ ok: false, code: 'upstream_error', status: 500, target: 'down-chat', attempts: 2 })
    expect(run.results.googleSearch).toMatchObject({ ok: false, code: 'upstream_error', status: 500 })
    expect(run.results.chatFallback).toMatchObject({ ok: true })
  })

  it('fails an empty reply, a search with no sources, and an embedding of the wrong size', async () => {
    expect((await runWithoutLive(env({ GEMINI_MODEL: 'empty-chat' }))).results.chat).toMatchObject({ ok: false, code: 'empty_reply' })
    expect((await runWithoutLive(env({ GEMINI_MODEL: 'nosrc-chat' }))).results.googleSearch).toMatchObject({ ok: false, code: 'no_sources' })
    expect((await runWithoutLive(env({ GEMINI_EMBEDDING_MODEL: 'embed-3' }))).results.embedding).toMatchObject({ ok: false, code: 'upstream_error' })
  })

  it('fails a model that never answers within the timeout', async () => {
    const run = await runWithoutLive(env({ GEMINI_MODEL: 'silent-chat' }), 300)
    expect(run.results.chat).toMatchObject({ ok: false, code: 'timeout' })
    expect(run.results.chat?.ms).toBeLessThan(5_000)
  })

  it('reports Tavily out of credits', async () => {
    const run = await runWithoutLive(env({ TAVILY_API_KEY: 'spent' }))
    expect(run.results.tavily).toMatchObject({ ok: false, code: 'tavily_error', status: 432 })
  })

  it('skips what has no key instead of failing it', async () => {
    seen.length = 0
    const run = await runProbes(probesFor(env({ GEMINI_API_KEY: undefined, TAVILY_API_KEY: undefined })))
    for (const result of Object.values(run.results)) expect(result.ok).toBeNull()
    expect(run.results.chat?.code).toBe('no_demo_key')
    expect(run.results.tavily?.code).toBe('no_tavily_key')
    expect(seen).toHaveLength(0)
  })

  it('checks the fallback only when it is a different model', () => {
    expect(probesFor(env({ GEMINI_FALLBACK_MODEL: 'ok-chat' })).map((p) => p.name)).not.toContain('chatFallback')
  })

  it('keeps upstream text out of the result', async () => {
    const probe: Probe = {
      name: 'chat',
      target: 'm',
      run: async () => {
        throw Object.assign(new GeminiError('demo_unavailable', 403), { message: 'API key AIzaSECRET not valid' })
      },
    }
    const run = await runProbes([probe], { retryDelayMs: 0 })
    expect(run.results.chat).toEqual({ target: 'm', ok: false, ms: expect.any(Number), code: 'demo_unavailable', status: 403, attempts: 2 })
    expect(JSON.stringify(run)).not.toContain('AIza')
  })
})

describe('the saved result', () => {
  const run: ModelCheckRun = { ranAt: 1_000, results: { chat: { target: 'm', ok: true, ms: 120 } } }

  it('starts the "not run yet" window on the first read, once', () => {
    const sql = memorySql()
    createModelCheckTable(sql)
    expect(readModelCheck(sql, 5_000)).toEqual({ lastRun: undefined, waitingSince: 5_000 })
    expect(readModelCheck(sql, 9_000)).toEqual({ lastRun: undefined, waitingSince: 5_000 })
  })

  it('keeps only the latest run', () => {
    const sql = memorySql()
    createModelCheckTable(sql)
    saveModelCheck(sql, run)
    saveModelCheck(sql, { ...run, ranAt: 2_000 })
    expect(readModelCheck(sql, 3_000).lastRun).toEqual({ ...run, ranAt: 2_000 })
  })
})

describe("health's freshness rules", () => {
  const hour = 60 * 60 * 1000
  const now = 100 * hour
  const passed: ModelCheckRun = {
    ranAt: now - 3 * hour,
    results: {
      chat: { target: 'a', ok: true, ms: 800 },
      live: { target: 'b', ok: true, ms: 400 },
      tavily: { target: 'tavily', ok: null, ms: 0, code: 'no_tavily_key' },
    },
  }

  it('is ok when the last run passed and is fresh', () => {
    const health = modelsHealth({ lastRun: passed, waitingSince: 0 }, now)
    expect(health.ok).toBe(true)
    expect(health.detail).toBe('2 of 3 answered 3 h ago; not checked (no key): Tavily')
  })

  it('is not ok when anything failed, naming what and why', () => {
    const failed = { ...passed, results: { ...passed.results, chat: { target: 'gemini-x', ok: false, ms: 20_000, code: 'upstream_error', status: 504 } } }
    const health = modelsHealth({ lastRun: failed, waitingSince: 0 }, now)
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('chat model (gemini-x): upstream_error 504')
  })

  it('is not ok when the last run is older than the window', () => {
    expect(modelsHealth({ lastRun: { ...passed, ranAt: now - MODEL_CHECK_FRESH_MS + 1000 }, waitingSince: 0 }, now).ok).toBe(true)
    const stale = modelsHealth({ lastRun: { ...passed, ranAt: now - MODEL_CHECK_FRESH_MS - 1000 }, waitingSince: 0 }, now)
    expect(stale.ok).toBe(false)
    expect(stale.detail).toMatch(/stale \(26 h ago\)/)
  })

  it('does not page right after a deploy, but does once a whole window passes with no run', () => {
    expect(modelsHealth({ waitingSince: now - hour }, now)).toEqual({ ok: null, detail: 'the daily model check has not run yet' })
    expect(modelsHealth({ waitingSince: now - MODEL_CHECK_FRESH_MS - 1000 }, now).ok).toBe(false)
  })

  it('says nothing was checked when no key is set', () => {
    const none: ModelCheckRun = { ranAt: now, results: { chat: { target: 'a', ok: null, ms: 0, code: 'no_demo_key' } } }
    expect(modelsHealth({ lastRun: none, waitingSince: 0 }, now).ok).toBeNull()
  })
})

describe('who can start it', () => {
  const ROOT = join(__dirname, '..', '..')
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

  it('only the Worker scheduled handler runs it; the fetch handler and the store cannot', () => {
    const worker = read('worker/index.ts')
    const scheduledAt = worker.indexOf('async scheduled(')
    const calls = [...worker.matchAll(/runModelCheck\(/g)].map((m) => m.index)
    expect(scheduledAt).toBeGreaterThan(worker.indexOf('async fetch('))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBeGreaterThan(scheduledAt)
    // The store's methods only save and read.
    expect(read('agent/model-check-store.ts')).not.toMatch(/runModelCheck|runProbes|probesFor/)
  })

  it('health only reads the saved result: it imports nothing that calls a model', () => {
    const health = read('app/api/health/route.ts')
    expect(health).not.toMatch(/from ['"][^'"]*agent\//)
    expect(health).toMatch(/MODEL_CHECK\.getByName\(MODEL_CHECK_INSTANCE\)\.state\(\)/)
  })
})
