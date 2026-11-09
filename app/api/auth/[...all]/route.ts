import { z } from 'zod'
import { createAuth } from '@/lib/server/auth'
import { clientIp } from '@/lib/server/client-ip'
import { getEnv } from '@/lib/server/env'
import { HttpError, errorResponse, readJson } from '@/lib/server/http'
import { DAILY_IP_LIMITS, DAILY_SIGN_IN_EMAILS_PER_ADDRESS } from '@/lib/limits'
import { log } from '@/lib/log'

/**
 * Better Auth's endpoints (/api/auth/*), behind Wren's own limits: a burst
 * limit per CF-Connecting-IP on every call, and before a sign-in email goes
 * out, durable daily caps per address and per IP so nobody can flood an inbox.
 */

const magicLinkBody = z.object({ email: z.email().max(254) })

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function handle(request: Request): Promise<Response> {
  try {
    const env = getEnv()
    const ip = clientIp(request)
    if (!(await env.AUTH_IP_LIMITER.limit({ key: `ip:${ip}` })).success) {
      return errorResponse('rate_limited', { headers: { 'Retry-After': '60' } })
    }
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/auth/sign-in/magic-link') {
      const parsed = magicLinkBody.safeParse(await readJson(request.clone() as Request, 4096))
      if (!parsed.success) return errorResponse('bad_request')
      const address = env.DAILY_COUNTER.getByName(`email:${await sha256(parsed.data.email.toLowerCase())}`)
      const network = env.DAILY_COUNTER.getByName(`ip:${ip}`)
      if (!(await address.take('signInEmails', DAILY_SIGN_IN_EMAILS_PER_ADDRESS))) return errorResponse('rate_limited')
      if (!(await network.take('signInEmails', DAILY_IP_LIMITS.signInEmails))) {
        await address.giveBack('signInEmails')
        return errorResponse('rate_limited')
      }
    }
    return await createAuth(env).handler(request)
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code)
    log.error('auth.unhandled', { code: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('internal')
  }
}

export const GET = handle
export const POST = handle
