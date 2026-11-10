import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIRST_TEXT_MS, GeminiError, streamReply, type StreamReplyOptions } from '../../agent/gemini'

// A stand-in for Gemini's streamGenerateContent. The model name decides the answer:
// "ok-*" streams two chunks, "silent-*" never answers, "down-*" fails with 500,
// "badkey-*" rejects the key, "half-*" sends one chunk and then breaks,
// "slow-*" answers after 250 ms (between the two waits below).
const calls: string[] = []
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const model = /models\/([^:]+):/.exec(req.url ?? '')?.[1] ?? ''
    calls.push(model)
    req.resume()
    req.on('end', () => {
      const chunk = (text: string) =>
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })}\r\n\r\n`
      if (model.startsWith('silent-')) return
      if (model.startsWith('down-')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 500, message: 'internal', status: 'INTERNAL' } }))
      }
      if (model.startsWith('badkey-')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } }))
      }
      if (model.startsWith('slow-')) {
        return setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(chunk(`${model} says hi`))
        }, 250)
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (model.startsWith('half-')) {
        res.write(chunk('Half '))
        return setTimeout(() => res.destroy(), 20)
      }
      res.write(chunk(`${model} says `))
      res.end(chunk('hi'))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

function options(model: string, fallbackModel?: string): StreamReplyOptions {
  return {
    apiKey: 'test-key',
    keySource: 'demo',
    model,
    fallbackModel,
    // The real waits are 10 s before the fallback and 20 s for the last model.
    firstTextMs: { beforeFallback: 100, last: 600 },
    systemPrompt: 'You are Wren.',
    history: [{ role: 'user', text: 'hi' }],
    signal: new AbortController().signal,
    baseUrl,
  }
}

async function answer(opts: StreamReplyOptions): Promise<string> {
  let text = ''
  for await (const chunk of streamReply(opts)) text += chunk
  return text
}

describe('chat model fallback', () => {
  it('answers with the main model when it works, without touching the fallback', async () => {
    calls.length = 0
    expect(await answer(options('ok-main', 'ok-backup'))).toBe('ok-main says hi')
    expect(calls).toEqual(['ok-main'])
  })

  it('moves to the fallback when the main model stays silent', async () => {
    calls.length = 0
    expect(await answer(options('silent-main', 'ok-backup'))).toBe('ok-backup says hi')
    expect(calls).toEqual(['silent-main', 'ok-backup'])
  })

  it('gives the first model the shorter wait and the last model the longer one', async () => {
    calls.length = 0
    // Slower than the first model's wait: chat switches.
    expect(await answer(options('slow-main', 'ok-backup'))).toBe('ok-backup says hi')
    // The fallback, and a model with no fallback, may take longer.
    expect(await answer(options('silent-main', 'slow-backup'))).toBe('slow-backup says hi')
    expect(await answer(options('slow-main'))).toBe('slow-main says hi')
    expect(calls).toEqual(['slow-main', 'ok-backup', 'silent-main', 'slow-backup', 'slow-main'])
  })

  it('keeps the real waits at 10 s before the fallback and 20 s for the last model', () => {
    expect(FIRST_TEXT_MS).toEqual({ beforeFallback: 10_000, last: 20_000 })
  })

  it('moves to the fallback when the main model fails before any text', async () => {
    expect(await answer(options('down-main', 'ok-backup'))).toBe('ok-backup says hi')
  })

  it('never retries a rejected key on another model', async () => {
    calls.length = 0
    await expect(answer(options('badkey-main', 'ok-backup'))).rejects.toMatchObject({ code: 'demo_unavailable' })
    expect(calls).toEqual(['badkey-main'])
  })

  it('does not restart an answer that already sent text', async () => {
    calls.length = 0
    const seen: string[] = []
    await expect(
      (async () => {
        for await (const chunk of streamReply(options('half-main', 'ok-backup'))) seen.push(chunk)
      })()
    ).rejects.toBeInstanceOf(GeminiError)
    expect(seen).toEqual(['Half '])
    expect(calls).toEqual(['half-main'])
  })

  it('reports a silent model as an upstream error when there is no fallback', async () => {
    await expect(answer(options('silent-main'))).rejects.toMatchObject({ code: 'upstream_error', upstreamStatus: 504 })
  })

  it('reports the fallback’s failure when both models fail', async () => {
    await expect(answer(options('silent-main', 'down-backup'))).rejects.toMatchObject({ code: 'upstream_error', upstreamStatus: 500 })
  })
})
