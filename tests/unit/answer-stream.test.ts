import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { answerStream, type AnswerStreamOptions } from '../../agent/answer-stream'
import { WREN_SYSTEM_PROMPT } from '../../agent/persona'
import type { ChatStreamEvent } from '../../lib/stream-events'

// A stand-in for Gemini's streamGenerateContent: "ok-*" streams two chunks,
// "slow-*" streams twenty 30 ms apart, "down-*" fails with 500, "half-*" breaks
// off with a mid-stream 503. It keeps each
// request's system instruction.
const systems: string[] = []
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const model = /models\/([^:]+):/.exec(req.url ?? '')?.[1] ?? ''
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { systemInstruction?: { parts?: { text: string }[] } }
      systems.push(body.systemInstruction?.parts?.map((p) => p.text).join('') ?? '')
      const chunk = (text: string) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })}\r\n\r\n`
      if (model.startsWith('down-')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 500, message: 'internal', status: 'INTERNAL' } }))
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (model.startsWith('half-')) {
        // Some text, then Gemini's mid-stream "overloaded".
        res.write(chunk('Half '))
        return res.end(`data: ${JSON.stringify({ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } })}\r\n\r\n`)
      }
      if (model.startsWith('slow-')) {
        let n = 0
        const timer = setInterval(() => {
          if (res.destroyed || n === 20) {
            clearInterval(timer)
            return res.end()
          }
          res.write(chunk(`w${n++} `))
        }, 30)
        return
      }
      res.write(chunk('Hello '))
      res.end(chunk('there'))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

const start: Extract<ChatStreamEvent, { t: 'start' }> = {
  t: 'start',
  chat: { id: 'c', title: 'Chat', updatedAt: 0 },
  userMessage: { id: 'u', role: 'user', content: 'hi there', status: 'done', createdAt: 0 },
  messageId: 'a',
  keySource: 'demo',
  usage: null,
}

function run(model: string, extra: Partial<AnswerStreamOptions> = {}) {
  const order: string[] = []
  const controller = new AbortController()
  const stream = answerStream({
    start,
    apiKey: 'test-key',
    keySource: 'demo',
    model,
    history: [{ role: 'user', text: 'hi there' }],
    baseUrl,
    controller,
    refund: async () => void order.push('refund'),
    finish: () => void order.push('finish'),
    ...extra,
  })
  const events = (async () => {
    const out: ChatStreamEvent[] = []
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line) out.push(JSON.parse(line) as ChatStreamEvent)
      if (out.at(-1)?.t === 'delta' && model.startsWith('slow-')) controller.abort()
    }
    return out
  })()
  return { events, order }
}

describe('answerStream when Gemini breaks off', () => {
  it('tells the browser to start again, saves only the new answer, and finishes it', async () => {
    const saves: [string, string][] = []
    const { events } = run('half-model', { fallbackModel: 'ok-backup', save: (text, status) => void saves.push([text, status]) })
    const sent = await events
    expect(sent.map((e) => e.t)).toEqual(['start', 'delta', 'restart', 'delta', 'delta', 'done'])
    expect(saves).toEqual([
      ['', 'partial'],
      ['Hello there', 'done'],
    ])
  })
})

describe('answerStream with memory', () => {
  it('sends recall events right after start and gives the model the recalled text', async () => {
    const recall: ChatStreamEvent = { t: 'recall', messageId: 'a', memories: [{ id: 'm', kind: 'fact', label: 'Has a dog named Juniper.' }] }
    const { events } = run('ok-model', { prepare: async () => ({ system: 'MEMORY CONTEXT', events: [recall] }) })
    const sent = await events
    expect(sent.map((e) => e.t)).toEqual(['start', 'recall', 'delta', 'delta', 'done'])
    expect(systems.at(-1)).toBe(`${WREN_SYSTEM_PROMPT}\n\nMEMORY CONTEXT`)
  })

  it('answers without recall when preparing fails', async () => {
    const { events } = run('ok-model', { prepare: async () => Promise.reject(new Error('no')) })
    expect((await events).map((e) => e.t)).toEqual(['start', 'delta', 'delta', 'done'])
    expect(systems.at(-1)).toBe(WREN_SYSTEM_PROMPT)
  })

  it('runs `after` once the answer is done and the chat is free, and sends its events before closing', async () => {
    const saved: ChatStreamEvent = { t: 'memory', messageId: 'u', saves: [] }
    const order: string[] = []
    const result = run('ok-model', {
      finish: () => void order.push('finish'),
      after: async () => {
        order.push('after')
        return [saved]
      },
    })
    const sent = await result.events
    expect(sent.map((e) => e.t)).toEqual(['start', 'delta', 'delta', 'done', 'memory'])
    expect(order).toEqual(['finish', 'after'])
  })

  it('skips `after` for a stopped or failed answer, and survives one that throws', async () => {
    let calls = 0
    const after = async () => {
      calls++
      return []
    }
    const stopped = run('slow-model', { after })
    expect((await stopped.events).at(-1)).toEqual({ t: 'done', status: 'stopped' })
    const failed = run('down-model', { after })
    expect((await failed.events).at(-1)).toEqual({ t: 'error', code: 'upstream_error' })
    expect(calls).toBe(0)
    const throwing = run('ok-model', { after: async () => Promise.reject(new Error('extractor down')) })
    expect((await throwing.events).at(-1)).toEqual({ t: 'done', status: 'done' })
  })
})
