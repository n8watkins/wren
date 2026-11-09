import { clientIp } from '@/lib/server/client-ip'
import { getEnv } from '@/lib/server/env'
import { newGuestCookie } from '@/lib/server/guest'
import { HttpError, errorResponse, jsonResponse, readJson } from '@/lib/server/http'
import { guestStart } from '@/lib/server/schemas'
import { guestChatConfigured, verifyTurnstile } from '@/lib/server/turnstile'
import { log } from '@/lib/log'

/**
 * Starts a guest session: a Turnstile token in, a signed HttpOnly guest
 * cookie out. Behind the same per-IP burst limit as sign-in.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const env = getEnv()
    if (!guestChatConfigured(env)) return errorResponse('guest_unavailable')
    const ip = clientIp(request)
    if (!(await env.AUTH_IP_LIMITER.limit({ key: `ip:${ip}` })).success) {
      return errorResponse('rate_limited', { headers: { 'Retry-After': '60' } })
    }
    const parsed = guestStart.safeParse(await readJson(request, 4096))
    if (!parsed.success) return errorResponse('bad_request')
    if (!(await verifyTurnstile(env, parsed.data.token, ip))) return errorResponse('turnstile_failed')
    const guest = await newGuestCookie(env)
    return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': guest.header } })
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code)
    log.error('api.unhandled', { route: 'guest.start', code: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('internal')
  }
}
