import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeminiError, embedText, generateJson } from '../../agent/gemini'
import { MemoryAiError } from '../../agent/memory'
import { memoryAi } from '../../agent/memory-ai'
import { createMeterTable, used } from '../../agent/meter'
import { EMBEDDING_DIMENSIONS, MEMORY_LIMITS } from '../../lib/memory'
import { utcDay } from '../../lib/limits'
import { mockEmbedding } from '../mocks/embedding.mjs'
import { memorySql } from '../support/sql'

// A stand-in for Gemini's batchEmbedContents and generateContent. The model
// name decides: "down-*" fails with 500, "prose-*" answers with text that
// isn't JSON; a key starting "bad-" is rejected.
const requests: { url: string; body: Record<string, unknown> }[] = []
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      requests.push({ url: req.url ?? '', body })
      const model = /models\/([^:]+):/.exec(req.url ?? '')?.[1] ?? ''
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (String(req.headers['x-goog-api-key']).startsWith('bad-')) {
        return send(400, { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } })
      }
      if (model.startsWith('down-')) return send(500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } })
      if (req.url?.includes(':batchEmbedContents')) {
        const requestsIn = body.requests as { content: { parts: { text: string }[] }; outputDimensionality: number }[]
        return send(200, {
          embeddings: requestsIn.map((r) => ({ values: mockEmbedding(r.content.parts[0].text, r.outputDimensionality) })),
        })
      }
      const text = model.startsWith('prose-') ? 'Sure! Here are the facts.' : JSON.stringify({ facts: [`from ${model}`] })
      return send(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((done) => server.close(() => done())))

const demo = { apiKey: 'test-demo-key', keySource: 'demo' as const }

describe('embedText', () => {
  it('asks for the index size and returns one vector', async () => {
    const values = await embedText({ ...demo, baseUrl, model: 'gemini-embedding-2', text: 'heat pump', dimensions: EMBEDDING_DIMENSIONS })
    expect(values).toHaveLength(EMBEDDING_DIMENSIONS)
    const sent = requests.at(-1)!
    expect(sent.url).toContain('models/gemini-embedding-2:batchEmbedContents')
    expect(JSON.stringify(sent.body)).toContain(`"outputDimensionality":${EMBEDDING_DIMENSIONS}`)
  })

  it('classifies a rejected key like chat does', async () => {
    await expect(
      embedText({ apiKey: 'bad-key', keySource: 'user', baseUrl, model: 'm', text: 'x', dimensions: EMBEDDING_DIMENSIONS })
    ).rejects.toEqual(new GeminiError('user_key_invalid', 400))
  })
})

describe('generateJson', () => {
  const ask = (model: string, fallbackModel?: string) =>
    generateJson({ ...demo, baseUrl, model, fallbackModel, systemPrompt: 'p', parts: [{ text: 'hi' }], schema: {} })

  it('returns the parsed reply', async () => {
    await expect(ask('ok-model')).resolves.toEqual({ facts: ['from ok-model'] })
  })

  it('tries the backup model once when the first is down', async () => {
    await expect(ask('down-model', 'ok-backup')).resolves.toEqual({ facts: ['from ok-backup'] })
  })

  it('treats a reply that is not JSON as an upstream error', async () => {
    await expect(ask('prose-model')).rejects.toEqual(new GeminiError('upstream_error'))
  })
})

describe('memoryAi', () => {
  function meterSql() {
    const sql = memorySql()
    createMeterTable(sql)
    return sql
  }
  const settings = { embeddingModel: 'gemini-embedding-2', model: 'ok-model' }

  it('takes a unit of the memory meter for each demo-key call, and stops at the daily limit', async () => {
    const sql = meterSql()
    const ai = memoryAi({ sql, demoKey: 'test-demo-key', baseUrl, ...settings })
    await ai.embed('one')
    await ai.json({ systemPrompt: 'p', parts: [{ text: 'x' }], schema: {} })
    expect(used(sql, utcDay(), 'memory')).toBe(2)
    sql.exec('UPDATE usage_daily SET used = ? WHERE kind = ?', MEMORY_LIMITS.dailyAiCalls, 'memory')
    await expect(ai.embed('more')).rejects.toEqual(new MemoryAiError('memory_daily_limit'))
  })

  it('gives the unit back when Gemini fails', async () => {
    const sql = meterSql()
    const ai = memoryAi({ sql, demoKey: 'test-demo-key', baseUrl, ...settings, model: 'down-model' })
    await expect(ai.json({ systemPrompt: 'p', parts: [{ text: 'x' }], schema: {} })).rejects.toEqual(new MemoryAiError('upstream_error'))
    expect(used(sql, utcDay(), 'memory')).toBe(0)
  })

  it('uses the person’s own key without the meter, and never falls back to the demo key', async () => {
    const sql = meterSql()
    await memoryAi({ sql, userKey: 'own-key-0123456789abcdef', demoKey: 'test-demo-key', baseUrl, ...settings }).embed('x')
    expect(used(sql, utcDay(), 'memory')).toBe(0)
    const bad = memoryAi({ sql, userKey: 'bad-key-0123456789abcdef', demoKey: 'test-demo-key', baseUrl, ...settings })
    await expect(bad.embed('x')).rejects.toEqual(new MemoryAiError('user_key_invalid'))
  })

  it('stops at the per-network daily count too, giving the person’s unit back', async () => {
    const sql = meterSql()
    let left = 1
    const given: number[] = []
    const network = { take: async () => left-- > 0, giveBack: async () => void given.push(1) }
    const ai = memoryAi({ sql, demoKey: 'test-demo-key', baseUrl, ...settings, network })
    await ai.embed('one')
    await expect(ai.embed('two')).rejects.toEqual(new MemoryAiError('memory_daily_limit'))
    expect(used(sql, utcDay(), 'memory')).toBe(1)
    const down = memoryAi({ sql, demoKey: 'test-demo-key', baseUrl, ...settings, model: 'down-model', network: { take: async () => true, giveBack: network.giveBack } })
    await expect(down.json({ systemPrompt: 'p', parts: [{ text: 'x' }], schema: {} })).rejects.toEqual(new MemoryAiError('upstream_error'))
    expect(given).toHaveLength(1)
  })

  it('never counts the person’s own key against the network', async () => {
    const network = { take: async () => false, giveBack: async () => undefined }
    const ai = memoryAi({ sql: meterSql(), userKey: 'own-key-0123456789abcdef', demoKey: 'test-demo-key', baseUrl, ...settings, network })
    await expect(ai.embed('x')).resolves.toHaveLength(768)
  })

  it('without any key, says the demo key is unavailable', async () => {
    await expect(memoryAi({ sql: meterSql(), baseUrl, ...settings }).embed('x')).rejects.toEqual(new MemoryAiError('demo_unavailable'))
  })
})
