import { describe, expect, it } from 'vitest'
import { checkUrl, fetchPage } from '../../lib/web/fetch-page'
import { htmlToText } from '../../lib/web/page-text'

/** A stand-in for the network: answers by URL, and records every address asked for. */
function network(routes: Record<string, () => Response | Promise<Response>>) {
  const asked: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    asked.push(url)
    expect(init?.redirect).toBe('manual')
    const route = routes[url]
    if (!route) throw new TypeError('fetch failed')
    return route()
  }) as typeof fetch
  return { fetchImpl, asked }
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } })
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { Location: to } })

describe('which addresses may be fetched', () => {
  it.each([
    'https://example.com/page',
    'http://news.ycombinator.com/item?id=1',
    'https://sub.domain.co.uk:443/a',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
    'https://xn--bcher-kva.example.org/',
  ])('allows %s', (url) => {
    expect(checkUrl(url).ok).toBe(true)
  })

  it.each([
    ['ftp://example.com/file', 'not_web_address'],
    ['file:///etc/passwd', 'not_web_address'],
    ['javascript:alert(1)', 'not_web_address'],
    ['data:text/html,<script>', 'not_web_address'],
    ['https://user:pass@example.com/', 'not_web_address'],
    ['https://example.com:22/', 'not_web_address'],
    ['not a url', 'not_web_address'],
    ['http://localhost/', 'private_address'],
    ['http://LOCALHOST./admin', 'private_address'],
    ['http://app.localhost/', 'private_address'],
    ['http://printer.local/', 'private_address'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'private_address'],
    ['http://intranet/', 'private_address'],
    ['http://127.0.0.1/', 'private_address'],
    ['http://127.1/', 'private_address'],
    ['http://2130706433/', 'private_address'],
    ['http://0x7f000001/', 'private_address'],
    ['http://0177.0.0.1/', 'private_address'],
    ['http://0.0.0.0/', 'private_address'],
    ['http://10.1.2.3/', 'private_address'],
    ['http://172.16.0.1/', 'private_address'],
    ['http://172.31.255.255/', 'private_address'],
    ['http://192.168.1.1/', 'private_address'],
    ['http://169.254.169.254/latest/meta-data/', 'private_address'],
    ['http://100.64.0.1/', 'private_address'],
    ['http://198.18.0.1/', 'private_address'],
    ['http://224.0.0.1/', 'private_address'],
    ['http://255.255.255.255/', 'private_address'],
    ['http://[::1]/', 'private_address'],
    ['http://[::]/', 'private_address'],
    ['http://[::ffff:127.0.0.1]/', 'private_address'],
    ['http://[::ffff:a9fe:a9fe]/', 'private_address'],
    ['http://[64:ff9b::a00:1]/', 'private_address'],
    ['http://[2002:7f00:1::]/', 'private_address'],
    ['http://[fc00::1]/', 'private_address'],
    ['http://[fd12:3456::1]/', 'private_address'],
    ['http://[fe80::1]/', 'private_address'],
    ['http://[ff02::1]/', 'private_address'],
    ['http://[2001:db8::1]/', 'private_address'],
  ])('refuses %s', (url, reason) => {
    expect(checkUrl(url)).toEqual({ ok: false, reason })
  })

  it('keeps public addresses next to private ranges public', () => {
    expect(checkUrl('http://172.32.0.1/').ok).toBe(true)
    expect(checkUrl('http://100.128.0.1/').ok).toBe(true)
    expect(checkUrl('http://[::ffff:8.8.8.8]/').ok).toBe(true)
  })
})

describe('fetching a page', () => {
  it('reads an HTML page as text, without scripts or styles', async () => {
    const { fetchImpl } = network({
      'https://example.com/a': () =>
        html('<html><head><title>A &amp; B</title><style>p{color:red}</style></head><body><script>steal()</script><p>Hello <b>world</b>.</p></body></html>'),
    })
    expect(await fetchPage('https://example.com/a', { fetchImpl })).toEqual({
      ok: true,
      url: 'https://example.com/a',
      kind: 'html',
      title: 'A & B',
      text: 'Hello world.',
    })
  })

  it('never asks for a private address', async () => {
    const { fetchImpl, asked } = network({})
    expect(await fetchPage('http://169.254.169.254/latest', { fetchImpl })).toEqual({ ok: false, reason: 'private_address' })
    expect(asked).toEqual([])
  })

  it('follows redirects and checks every hop', async () => {
    const { fetchImpl, asked } = network({
      'https://short.example.com/x': () => redirect('/y', 301),
      'https://short.example.com/y': () => redirect('https://pages.example.org/final#frag'),
      'https://pages.example.org/final': () => html('<p>Arrived.</p>'),
    })
    const page = await fetchPage('https://short.example.com/x', { fetchImpl })
    expect(page).toMatchObject({ ok: true, url: 'https://pages.example.org/final', text: 'Arrived.' })
    expect(asked).toEqual(['https://short.example.com/x', 'https://short.example.com/y', 'https://pages.example.org/final'])
  })

  it('refuses a redirect to a private address without following it', async () => {
    const { fetchImpl, asked } = network({
      'https://evil.example.com/': () => redirect('http://127.0.0.1:8080/admin'),
    })
    expect(await fetchPage('https://evil.example.com/', { fetchImpl })).toEqual({ ok: false, reason: 'private_address' })
    expect(asked).toEqual(['https://evil.example.com/'])
  })

  it('refuses a redirect to another scheme', async () => {
    const { fetchImpl } = network({ 'https://a.example.com/': () => redirect('file:///etc/passwd') })
    expect(await fetchPage('https://a.example.com/', { fetchImpl })).toEqual({ ok: false, reason: 'not_web_address' })
  })

  it('stops after a few redirects', async () => {
    const routes: Record<string, () => Response> = {}
    for (let i = 0; i < 10; i++) routes[`https://loop.example.com/${i}`] = () => redirect(`/${i + 1}`)
    const { fetchImpl, asked } = network(routes)
    expect(await fetchPage('https://loop.example.com/0', { fetchImpl, maxRedirects: 4 })).toEqual({ ok: false, reason: 'too_many_redirects' })
    expect(asked).toHaveLength(5)
  })

  it('refuses a body larger than the cap, whatever Content-Length says', async () => {
    const big = 'x'.repeat(2048)
    const { fetchImpl } = network({
      'https://a.example.com/declared': () => html('<p>small</p>', { 'Content-Length': '999999999' }),
      'https://a.example.com/streamed': () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode(big))
              controller.close()
            },
          }),
          { headers: { 'Content-Type': 'text/plain' } }
        ),
    })
    expect(await fetchPage('https://a.example.com/declared', { fetchImpl, maxBytes: 4096 })).toEqual({ ok: false, reason: 'too_large' })
    expect(await fetchPage('https://a.example.com/streamed', { fetchImpl, maxBytes: 4096 })).toEqual({ ok: false, reason: 'too_large' })
  })

  it.each(['application/octet-stream', 'image/png', 'application/javascript', 'application/json', 'video/mp4', ''])(
    'refuses content of type "%s"',
    async (type) => {
      const { fetchImpl } = network({ 'https://a.example.com/f': () => new Response('data', { headers: type ? { 'Content-Type': type } : {} }) })
      // A Response with a string body defaults to text/plain, so the empty case drops it.
      if (!type) {
        const response = new Response('data')
        response.headers.delete('content-type')
        expect(await fetchPage('https://a.example.com/f', { fetchImpl: (async () => response) as typeof fetch })).toEqual({
          ok: false,
          reason: 'unsupported_type',
        })
        return
      }
      expect(await fetchPage('https://a.example.com/f', { fetchImpl })).toEqual({ ok: false, reason: 'unsupported_type' })
    }
  )

  it('accepts plain text and returns a PDF as bytes', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const { fetchImpl } = network({
      'https://a.example.com/t': () => new Response('  Plain   words.  ', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
      'https://a.example.com/p': () => new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } }),
    })
    expect(await fetchPage('https://a.example.com/t', { fetchImpl })).toMatchObject({ ok: true, kind: 'text', text: 'Plain words.' })
    const page = await fetchPage('https://a.example.com/p', { fetchImpl })
    expect(page).toMatchObject({ ok: true, kind: 'pdf' })
    expect(page.ok && page.kind === 'pdf' && Array.from(page.bytes)).toEqual([0x25, 0x50, 0x44, 0x46])
  })

  it('gives up on a slow site', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch
    expect(await fetchPage('https://slow.example.com/', { fetchImpl, timeoutMs: 50 })).toEqual({ ok: false, reason: 'timeout' })
  })

  it('reports errors and pages without text', async () => {
    const { fetchImpl } = network({
      'https://a.example.com/404': () => new Response('gone', { status: 404, headers: { 'Content-Type': 'text/html' } }),
      'https://a.example.com/empty': () => html('<script>only()</script>'),
    })
    expect(await fetchPage('https://a.example.com/404', { fetchImpl })).toEqual({ ok: false, reason: 'http_error', status: 404 })
    expect(await fetchPage('https://a.example.com/empty', { fetchImpl })).toEqual({ ok: false, reason: 'no_text' })
    expect(await fetchPage('https://unreachable.example.com/', { fetchImpl })).toEqual({ ok: false, reason: 'network' })
  })
})

describe('HTML to text', () => {
  it('keeps the main content and drops page furniture', () => {
    const page = htmlToText(`<!doctype html><html><head><title>Guide</title><script>var x = "<p>not text</p>"</script></head>
      <body><nav><a href="/">Home</a></nav><main><h1>E-bikes</h1><p>Batteries &mdash; 500&nbsp;Wh.</p>
      <ul><li>One</li><li>Two</li></ul><!-- hidden comment --><noscript>enable js</noscript>
      <form><input value="secret"></form><table><tr><td>a</td><td>b</td></tr></table></main><footer>© 2026</footer></body></html>`)
    expect(page.title).toBe('Guide')
    expect(page.text).toBe('E-bikes\n\nBatteries - 500 Wh.\n\n- One\n- Two\n\na b')
  })

  it('decodes entities but never invents markup', () => {
    expect(htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt; &#65;&#x42; &bogus;</p>').text).toBe('<script>alert(1)</script> AB &bogus;')
  })

  it('removes zero-width and direction-changing characters that hide text', () => {
    expect(htmlToText('<p>a​b‮c﻿d</p>').text).toBe('abcd')
  })

  it('drops an unclosed script to the end of the page', () => {
    expect(htmlToText('<p>Before</p><script>evil(); <p>after</p>').text).toBe('Before')
  })
})
