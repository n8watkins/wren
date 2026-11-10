import { FETCH_LIMITS } from '../limits'
import { htmlToText, tidy } from './page-text'

/**
 * Fetching a page someone else controls, safely (docs/LESSONS.md, "fetching
 * URLs unsafely"). Research reads pages with it; Memory can reuse it for links.
 *
 * - Only http and https on the usual ports, no user:password in the address.
 * - Never a local or private address: localhost, *.local, *.internal,
 *   single-label names, and private, loopback, link-local, shared, test,
 *   multicast and reserved IPv4 and IPv6 ranges (including IPv4 mapped into IPv6).
 *   Names that resolve to such addresses can't be checked before the fetch in
 *   a Worker; Cloudflare's network doesn't route Worker fetches to them.
 * - Redirects are followed by hand, at most FETCH_LIMITS.redirects, and every
 *   hop is checked again.
 * - FETCH_LIMITS.timeoutMs for the whole fetch, body included, and at most
 *   FETCH_LIMITS.bytes of body, counted as it arrives.
 * - Only HTML, plain text and PDF. HTML comes back as readable text (scripts,
 *   styles and markup removed); a PDF comes back as bytes for the caller.
 *
 * What comes back is still untrusted text, never instructions.
 */

export type SkipReason =
  | 'not_web_address'
  | 'private_address'
  | 'too_many_redirects'
  | 'http_error'
  | 'timeout'
  | 'too_large'
  | 'unsupported_type'
  | 'no_text'
  | 'network'

/** What the Runs page says about a page that wasn't read. */
export const SKIP_REASONS: Record<SkipReason, string> = {
  not_web_address: 'not a web address',
  private_address: 'a private or local address',
  too_many_redirects: 'too many redirects',
  http_error: 'the site answered with an error',
  timeout: 'took longer than 10 seconds',
  too_large: 'larger than 2 MB',
  unsupported_type: 'not a web page, text or PDF',
  no_text: 'no readable text',
  network: 'could not be reached',
}

export type PageResult =
  | { ok: true; url: string; kind: 'html' | 'text'; title: string; text: string }
  | { ok: true; url: string; kind: 'pdf'; title: string; bytes: Uint8Array }
  | { ok: false; reason: SkipReason; status?: number }

const PORTS = new Set(['', '80', '443', '8080', '8443'])

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa', '.localdomain', '.test', '.invalid', '.example', '.onion']

/** IPv4 ranges that aren't the public internet (RFC 6890 and friends). */
const PRIVATE_V4: [number, number][] = [
  [0x00000000, 8], // "this network"
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, cloud metadata
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // TEST-NET-1
  [0xc0586300, 24], // 6to4 relay anycast
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // TEST-NET-2
  [0xcb007100, 24], // TEST-NET-3
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved, broadcast
]

function parseV4(host: string): number | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null
  return parts.reduce((n, p) => n * 256 + Number(p), 0)
}

function privateV4(n: number): boolean {
  return PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)))
}

/** An IPv6 literal (without brackets) as 8 numbers, or null. */
function parseV6(host: string): number[] | null {
  let text = host.toLowerCase()
  // IPv4 written in the last 32 bits.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const v4 = parseV4(dotted[1])
    if (v4 === null) return null
    text = `${text.slice(0, -dotted[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const read = (part: string) => (part ? part.split(':') : [])
  const head = read(halves[0])
  const tail = halves.length === 2 ? read(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

function privateV6(g: number[]): boolean {
  const v4 = (g[6] << 16) + g[7]
  const zeroTo = (end: number) => g.slice(0, end).every((x) => x === 0)
  if (zeroTo(8)) return true // ::
  if (zeroTo(7) && g[7] === 1) return true // ::1
  if (zeroTo(5) && g[5] === 0xffff) return privateV4(v4 >>> 0) // ::ffff:a.b.c.d
  if (zeroTo(6)) return true // ::a.b.c.d (deprecated compatible form)
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(v4 >>> 0) // NAT64
  if (g[0] === 0x2002) return privateV4(((g[1] << 16) + g[2]) >>> 0) // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true // site-local
  if ((g[0] & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
  if (g[0] === 0x2001 && g[1] < 0x200) return true // Teredo, benchmarking, ORCHID
  return (g[0] & 0xe000) !== 0x2000 // only global unicast (2000::/3) is public
}

/** Whether a URL is one Wren may fetch, and the parsed URL when it is. */
export function checkUrl(raw: string | URL): { ok: true; url: URL } | { ok: false; reason: SkipReason } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not_web_address' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'not_web_address' }
  if (url.username || url.password || !PORTS.has(url.port)) return { ok: false, reason: 'not_web_address' }
  // URL has already normalised the host: lower case, punycode, and IPv4 in any
  // notation (decimal, octal, hex, short forms) rewritten as dotted decimal.
  const host = url.hostname.replace(/\.$/, '')
  if (!host) return { ok: false, reason: 'not_web_address' }
  if (host.startsWith('[')) {
    const groups = parseV6(host.slice(1, -1))
    return groups && !privateV6(groups) ? { ok: true, url } : { ok: false, reason: 'private_address' }
  }
  const v4 = parseV4(host)
  if (v4 !== null) return privateV4(v4) ? { ok: false, reason: 'private_address' } : { ok: true, url }
  if (host === 'localhost' || !host.includes('.') || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: 'private_address' }
  }
  return { ok: true, url }
}

const ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.8'
const USER_AGENT = 'WrenResearch/1.0 (+https://wren.n8builds.dev)'

function kindOf(contentType: string): 'html' | 'text' | 'pdf' | null {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'text/plain' || type === 'text/markdown') return 'text'
  if (type === 'application/pdf') return 'pdf'
  return null
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Reads at most `max` bytes of a body; null when there was more. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export interface FetchPageOptions {
  signal?: AbortSignal
  /** Tests pass a stand-in for the network. */
  fetchImpl?: typeof fetch
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
}

export async function fetchPage(address: string, options: FetchPageOptions = {}): Promise<PageResult> {
  const doFetch = options.fetchImpl ?? fetch
  const maxBytes = options.maxBytes ?? FETCH_LIMITS.bytes
  const maxRedirects = options.maxRedirects ?? FETCH_LIMITS.redirects
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_LIMITS.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

  let checked = checkUrl(address)
  try {
    for (let hop = 0; ; hop++) {
      if (!checked.ok) return checked
      const url = checked.url
      url.hash = ''
      const response = await doFetch(url.toString(), {
        redirect: 'manual',
        signal,
        headers: { Accept: ACCEPT, 'User-Agent': USER_AGENT },
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        const location = response.headers.get('location')
        if (!location) return { ok: false, reason: 'http_error', status: response.status }
        if (hop >= maxRedirects) return { ok: false, reason: 'too_many_redirects' }
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          return { ok: false, reason: 'not_web_address' }
        }
        checked = checkUrl(next)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return { ok: false, reason: 'http_error', status: response.status }
      }
      const contentType = response.headers.get('content-type') ?? ''
      const kind = kindOf(contentType)
      if (!kind) {
        await response.body?.cancel().catch(() => undefined)
        return { ok: false, reason: 'unsupported_type' }
      }
      if (Number(response.headers.get('content-length') ?? '0') > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        return { ok: false, reason: 'too_large' }
      }
      const bytes = response.body ? await readCapped(response.body, maxBytes) : new Uint8Array()
      if (!bytes) return { ok: false, reason: 'too_large' }
      const finalUrl = url.toString()
      if (kind === 'pdf') return { ok: true, url: finalUrl, kind, title: '', bytes }
      const raw = decode(bytes, contentType)
      const page = kind === 'html' ? htmlToText(raw) : { title: '', text: tidy(raw) }
      if (!page.text) return { ok: false, reason: 'no_text' }
      return { ok: true, url: finalUrl, kind, title: page.title, text: page.text }
    }
  } catch {
    if (timeout.aborted) return { ok: false, reason: 'timeout' }
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted')
    return { ok: false, reason: 'network' }
  }
}
