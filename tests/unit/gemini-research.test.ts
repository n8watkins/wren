import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateText } from '../../agent/gemini'

// A stand-in for Gemini's generateContent. The model name decides the answer:
// "ok-*" answers, "down-*" fails with 500, "badkey-*" rejects the key, "slow-*"
// never answers. Every request body is kept for the assertions.
const calls: { model: string; body: Record<string, unknown> }[] = []
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const model = /models\/([^:]+):/.exec(req.url ?? '')?.[1] ?? ''
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      calls.push({ model, body })
      if (model.startsWith('slow-')) return
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (model.startsWith('down-')) return json(500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } })
      if (model.startsWith('badkey-')) return json(400, { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } })
      json(200, {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: `${model} answered` }] },
            finishReason: 'STOP',
          },
        ],
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

const base = (model: string, fallbackModel?: string) => ({
  apiKey: 'test-key',
  keySource: 'demo' as const,
  model,
  fallbackModel,
  signal: new AbortController().signal,
  timeoutMs: 300,
  baseUrl,
})

describe('research calls to Gemini', () => {
  it('asks for JSON when planning, with the system prompt on the server side', async () => {
    calls.length = 0
    const text = await generateText({ ...base('ok-main'), systemPrompt: 'Plan.', parts: [{ text: 'Question: q' }], json: true })
    expect(text).toBe('ok-main answered')
    const body = calls[0].body as { generationConfig?: { responseMimeType?: string }; systemInstruction?: unknown; tools?: unknown }
    expect(body.generationConfig?.responseMimeType).toBe('application/json')
    expect(JSON.stringify(body.systemInstruction)).toContain('Plan.')
    // Tavily is the only search: no research call asks for Gemini's Google Search tool.
    expect(body.tools).toBeUndefined()
  })

  it('sends a PDF as inline data', async () => {
    calls.length = 0
    await generateText({ ...base('ok-main'), systemPrompt: 'Read.', parts: [{ pdf: new Uint8Array([37, 80, 68, 70]) }, { text: 'Write it out.' }] })
    expect(JSON.stringify(calls[0].body.contents)).toContain('"inlineData":{"mimeType":"application/pdf","data":"JVBERg=="}')
  })

  it('falls back to the second model when the first fails or stays silent', async () => {
    calls.length = 0
    expect(await generateText({ ...base('down-main', 'ok-backup'), systemPrompt: 's', parts: [{ text: 'x' }] })).toBe('ok-backup answered')
    expect(await generateText({ ...base('slow-main', 'ok-backup'), systemPrompt: 's', parts: [{ text: 'x' }] })).toBe('ok-backup answered')
    expect(calls.map((c) => c.model)).toEqual(['down-main', 'ok-backup', 'slow-main', 'ok-backup'])
  })

  it('never retries a rejected key', async () => {
    calls.length = 0
    await expect(generateText({ ...base('badkey-main', 'ok-backup'), systemPrompt: 's', parts: [{ text: 'x' }] })).rejects.toMatchObject({
      code: 'demo_unavailable',
    })
    expect(calls).toHaveLength(1)
  })
})
