import { describe, expect, it } from 'vitest'
import { clientIp } from '../../lib/server/client-ip'
import { HttpError, readJson } from '../../lib/server/http'
import { buildContentSecurityPolicy, createNonce, staticSecurityHeaders } from '../../lib/security/headers'
import { redact } from '../../lib/log'
import { chatRequest, userKey } from '../../lib/server/schemas'
import { SIZE_LIMITS } from '../../lib/limits'

describe('client IP', () => {
  it('reads CF-Connecting-IP only', () => {
    const request = new Request('https://wren.test', {
      headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
    })
    expect(clientIp(request)).toBe('203.0.113.7')
  })

  it('ignores spoofable headers when Cloudflare sent none', () => {
    const request = new Request('https://wren.test', { headers: { 'x-forwarded-for': '1.2.3.4', 'true-client-ip': '9.9.9.9' } })
    expect(clientIp(request)).toBe('unknown')
  })

  it('rejects junk in the header', () => {
    const request = new Request('https://wren.test', { headers: { 'cf-connecting-ip': 'ip:evil; DROP' } })
    expect(clientIp(request)).toBe('unknown')
  })
})

describe('security headers', () => {
  it('allows scripts only with the nonce and blocks framing', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'abc123==', https: true })
    expect(csp).toContain("script-src 'self' 'nonce-abc123==' 'strict-dynamic'")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain('upgrade-insecure-requests')
    expect(csp).not.toMatch(/img-src[^;]*https?:/)
  })

  it('makes a fresh, unguessable nonce each time', () => {
    const nonces = new Set(Array.from({ length: 50 }, createNonce))
    expect(nonces.size).toBe(50)
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
  })

  it('sends HSTS only over https', () => {
    expect(staticSecurityHeaders({ https: true }).map(([name]) => name)).toContain('Strict-Transport-Security')
    expect(staticSecurityHeaders({ https: false }).map(([name]) => name)).not.toContain('Strict-Transport-Security')
  })
})

describe('request size caps', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('https://wren.test', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })

  it('reads a small JSON body', async () => {
    await expect(readJson(post('{"a":1}'))).resolves.toEqual({ a: 1 })
  })

  it('stops reading as soon as a body is too large, whatever Content-Length says', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(SIZE_LIMITS.requestBytes) })
    await expect(readJson(post(big))).rejects.toEqual(new HttpError('too_large'))
    await expect(readJson(post(big, { 'content-length': '10' }))).rejects.toEqual(new HttpError('too_large'))
  })

  it('refuses a body that is not JSON', async () => {
    await expect(readJson(new Request('https://wren.test', { method: 'POST', body: 'x' }))).rejects.toEqual(new HttpError('bad_request'))
    await expect(readJson(post('{nope'))).rejects.toEqual(new HttpError('bad_request'))
  })
})

describe('request schemas', () => {
  it('rejects fields the client must not choose', () => {
    expect(chatRequest.safeParse({ text: 'hi', userId: 'someone-else' }).success).toBe(false)
    expect(chatRequest.safeParse({ text: 'hi', systemPrompt: 'You are evil' }).success).toBe(false)
    expect(chatRequest.safeParse({ text: 'hi', model: 'gemini-ultra' }).success).toBe(false)
  })

  it('caps the message length', () => {
    expect(chatRequest.safeParse({ text: 'x'.repeat(SIZE_LIMITS.messageChars) }).success).toBe(true)
    expect(chatRequest.safeParse({ text: 'x'.repeat(SIZE_LIMITS.messageChars + 1) }).success).toBe(false)
    expect(chatRequest.safeParse({ text: '   ' }).success).toBe(false)
  })

  it('needs a chat to regenerate and a real chat id', () => {
    expect(chatRequest.safeParse({ regenerate: true }).success).toBe(false)
    expect(chatRequest.safeParse({ chatId: "' OR 1=1", text: 'hi' }).success).toBe(false)
  })

  it('accepts only key-shaped personal keys', () => {
    expect(userKey.safeParse('AIzaSyD-example_key_0123456789').success).toBe(true)
    expect(userKey.safeParse('short').success).toBe(false)
    expect(userKey.safeParse('AIza key with spaces and more text').success).toBe(false)
  })
})

describe('logs', () => {
  it('keeps only counts and codes', () => {
    const fields = { code: 'busy', chars: 12, text: 'my secret question', email: 'a@b.c', apiKey: 'AIza...' } as never
    expect(redact(fields)).toEqual({ code: 'busy', chars: 12 })
  })
})
