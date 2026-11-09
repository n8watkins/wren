// A local stand-in for the Gemini API's streamGenerateContent endpoint, so the
// E2E tests never call Google or spend a key. The Worker under test points at
// it with GEMINI_BASE_URL (playwright.config.ts). What it answers depends on
// the last user message:
//   "mock:slow ..."     streams 40 chunks, 150 ms apart (for Stop)
//   "mock:xss"          answers with hostile Markdown and HTML
//   "mock:fail"         a 500 before any text
// and on the key: one starting "bad-" gets Gemini's invalid-key answer.
import { createServer } from 'node:http'

const port = Number(process.env.MOCK_GEMINI_PORT ?? 3127)
const host = process.env.E2E_HOST ?? '127.0.0.2'

const XSS = [
  'Here is **bold** text and a [safe link](https://example.com).',
  '',
  '<script>window.__xss = 1</script><img src=x onerror="window.__xss=2">',
  '',
  '[click](javascript:window.__xss=3) ![tracker](https://evil.example/p.png?d=secret)',
].join('\n')

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
    if (!/:streamGenerateContent/.test(req.url ?? '')) {
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
    const turns = body.contents ?? []
    const last = turns.filter((t) => t.role === 'user').at(-1)?.parts?.[0]?.text ?? ''
    if (last.startsWith('mock:fail')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 500, message: 'internal', status: 'INTERNAL' } }))
      return
    }
    if (last.startsWith('mock:xss')) return sse(res, [XSS], 10)
    if (last.startsWith('mock:slow')) return sse(res, Array.from({ length: 40 }, (_, n) => `word${n} `), 150)
    const reply = `You said: "${last}". This is turn ${turns.filter((t) => t.role === 'user').length} of our **chat**.`
    return sse(res, reply.match(/.{1,12}/gs) ?? [reply], 15)
  })
}).listen(port, host, () => console.log(`mock gemini on ${host}:${port}`))
