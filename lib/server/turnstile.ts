import 'server-only'
import { optionalSetting } from '../secrets'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Whether this deployment can offer guest chat: Turnstile's keys are set. */
export function guestChatConfigured(env: CloudflareEnv): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && optionalSetting(env, 'TURNSTILE_SECRET_KEY'))
}

/**
 * Checks a Turnstile token with Cloudflare's siteverify, from the server only.
 * Fails closed: a missing secret, a network error or anything but
 * `success: true` is a failure.
 */
export async function verifyTurnstile(env: CloudflareEnv, token: string, ip: string): Promise<boolean> {
  const secret = optionalSetting(env, 'TURNSTILE_SECRET_KEY')
  if (!secret || !token) return false
  const body = new FormData()
  body.set('secret', secret)
  body.set('response', token)
  if (ip !== 'unknown') body.set('remoteip', ip)
  body.set('idempotency_key', crypto.randomUUID())
  try {
    const response = await fetch(optionalSetting(env, 'TURNSTILE_VERIFY_URL') ?? SITEVERIFY, { method: 'POST', body })
    if (!response.ok) return false
    const result = (await response.json()) as { success?: unknown }
    return result.success === true
  } catch {
    return false
  }
}
