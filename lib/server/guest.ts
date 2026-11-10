import 'server-only'
import { GUEST_LIMITS } from '../limits'
import { base64url, fromBase64url } from '../security/base64url'

/**
 * The guest cookie: a random id, an expiry and an HMAC over both, keyed from
 * BETTER_AUTH_SECRET with its own label. HttpOnly, so scripts can't read it;
 * signed, so a guest can't pick someone else's id or extend their own. It is
 * only issued after a Turnstile check (app/api/guest/start/route.ts).
 */

const LABEL = 'wren-guest-cookie-v1'

function cookieName(https: boolean): string {
  return https ? '__Host-wren_guest' : 'wren_guest'
}

async function key(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${LABEL}:${secret}`)
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signGuest(secret: string, id: string, expires: number): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(`${id}.${expires}`))
  return `${id}.${expires}.${base64url(signature)}`
}

/** The guest id in a cookie value, if the signature is ours and it hasn't expired. */
export async function verifyGuest(secret: string, value: string, now = Date.now()): Promise<string | null> {
  const parts = value.split('.')
  if (parts.length !== 3) return null
  const [id, expiresText, signatureText] = parts
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^\d{10,13}$/.test(expiresText)) return null
  const expires = Number(expiresText)
  if (expires < now) return null
  const signature = fromBase64url(signatureText)
  if (!signature) return null
  const valid = await crypto.subtle.verify('HMAC', await key(secret), signature, new TextEncoder().encode(`${id}.${expiresText}`))
  return valid ? id : null
}

/** A new guest: the id and the Set-Cookie header that carries it. */
export async function newGuestCookie(env: CloudflareEnv): Promise<{ id: string; header: string }> {
  const https = new URL(env.PUBLIC_URL).protocol === 'https:'
  const id = crypto.randomUUID()
  const expires = Date.now() + GUEST_LIMITS.cookieSeconds * 1000
  const value = await signGuest(env.BETTER_AUTH_SECRET, id, expires)
  const attributes = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${GUEST_LIMITS.cookieSeconds}`, ...(https ? ['Secure'] : [])]
  return { id, header: `${cookieName(https)}=${value}; ${attributes.join('; ')}` }
}

/** The verified guest id behind this request, or null. */
export async function readGuest(env: CloudflareEnv, headers: Headers): Promise<string | null> {
  const https = new URL(env.PUBLIC_URL).protocol === 'https:'
  const name = cookieName(https)
  const cookie = headers.get('cookie') ?? ''
  for (const part of cookie.split(';')) {
    const [rawName, ...rest] = part.trim().split('=')
    if (rawName === name) return verifyGuest(env.BETTER_AUTH_SECRET, rest.join('='))
  }
  return null
}
