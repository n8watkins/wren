import 'server-only'
import { getEnv } from './env'
import { HttpError, errorResponse } from './http'
import { readGuest } from './guest'
import { withinBurstLimits } from './rate-limit'
import { getVerifiedSession, type VerifiedSession } from './session'
import { log } from '../log'

export interface AuthedContext {
  env: CloudflareEnv
  session: VerifiedSession
  request: Request
}

/**
 * Wraps every API route that acts for a person: no session, no access; the
 * burst limits (per user and per CF-Connecting-IP) come next; errors become
 * the shared JSON shape. tests/unit/lessons.test.ts fails if an API route
 * other than auth and health doesn't use it.
 */
export function authed<P = unknown>(
  name: string,
  handler: (context: AuthedContext, params: P) => Promise<Response>
) {
  return async (request: Request, routeContext: { params: Promise<P> }): Promise<Response> => {
    try {
      const env = getEnv()
      const session = await getVerifiedSession(env, request.headers)
      if (!session) return errorResponse('unauthorized')
      if (!(await withinBurstLimits(env, request, session.userId))) {
        return errorResponse('rate_limited', { headers: { 'Retry-After': '30' } })
      }
      return await handler({ env, session, request }, await routeContext.params)
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.code)
      log.error('api.unhandled', { route: name, code: error instanceof Error ? error.name : 'unknown' })
      return errorResponse('internal')
    }
  }
}

export interface GuestContext {
  env: CloudflareEnv
  guestId: string
  request: Request
}

/**
 * Wraps the guest API routes: the guest id comes only from the signed guest
 * cookie (issued after a Turnstile check); then the burst limits per guest
 * and per CF-Connecting-IP.
 */
export function guestOnly(name: string, handler: (context: GuestContext) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      const env = getEnv()
      const guestId = await readGuest(env, request.headers)
      if (!guestId) return errorResponse('guest_required')
      if (!(await withinBurstLimits(env, request, `guest:${guestId}`))) {
        return errorResponse('rate_limited', { headers: { 'Retry-After': '30' } })
      }
      return await handler({ env, guestId, request })
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.code)
      log.error('api.unhandled', { route: name, code: error instanceof Error ? error.name : 'unknown' })
      return errorResponse('internal')
    }
  }
}
