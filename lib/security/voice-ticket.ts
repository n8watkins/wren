import { base64url, fromBase64url } from './base64url'

/**
 * A voice ticket: what lets a browser open the voice socket (GET /api/voice).
 * A WebSocket can't be upgraded inside a Next route, so the Worker takes the
 * socket (worker/voice.ts) and needs to know whose it is without running
 * Better Auth itself. POST /api/voice/ticket verifies the session the usual
 * way (authed()) and signs who, which chat, which network and until when;
 * the Worker checks the signature, the expiry and the network, and the
 * person's agent takes each ticket once.
 */

const LABEL = 'wren-voice-ticket-v1'

export interface VoiceTicket {
  /** The verified session's user id: names the agent the socket goes to. */
  userId: string
  /** The chat to talk in, or null to start one with the first words. */
  chatId: string | null
  /** CF-Connecting-IP when the ticket was made; the socket must come from the same network. */
  ip: string
  /** Milliseconds since the epoch. */
  expires: number
  /** Random, so the agent can take each ticket once. */
  nonce: string
}

async function key(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${LABEL}:${secret}`)
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signVoiceTicket(secret: string, ticket: VoiceTicket): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(ticket)))
  const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(payload))
  return `${payload}.${base64url(signature)}`
}

function isTicket(value: unknown): value is VoiceTicket {
  if (!value || typeof value !== 'object') return false
  const claims = value as Record<string, unknown>
  return (
    typeof claims.userId === 'string' &&
    claims.userId.length > 0 &&
    claims.userId.length <= 64 &&
    !claims.userId.includes(':') &&
    (claims.chatId === null || (typeof claims.chatId === 'string' && /^[0-9a-f-]{36}$/.test(claims.chatId))) &&
    typeof claims.ip === 'string' &&
    claims.ip.length <= 45 &&
    typeof claims.expires === 'number' &&
    typeof claims.nonce === 'string' &&
    /^[0-9a-f-]{36}$/.test(claims.nonce)
  )
}

/** The ticket, if the signature is ours and it hasn't expired. */
export async function verifyVoiceTicket(secret: string, value: string, now = Date.now()): Promise<VoiceTicket | null> {
  if (value.length > 1024) return null
  const parts = value.split('.')
  if (parts.length !== 2) return null
  const [payload, signatureText] = parts
  const signature = fromBase64url(signatureText)
  const bytes = fromBase64url(payload)
  if (!signature || !bytes) return null
  const valid = await crypto.subtle.verify('HMAC', await key(secret), signature, new TextEncoder().encode(payload))
  if (!valid) return null
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!isTicket(claims) || claims.expires < now) return null
  return claims
}

/** The page's own origin; local runs may also be on localhost, on any port. */
export function voiceOriginAllowed(origin: string | null, env: { PUBLIC_URL: string; APP_ENV: string }): boolean {
  if (!origin) return false
  if (origin === new URL(env.PUBLIC_URL).origin) return true
  return env.APP_ENV !== 'production' && /^http:\/\/localhost(:\d{1,5})?$/.test(origin)
}
