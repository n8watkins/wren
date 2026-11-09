import { guestAgentFor } from '@/lib/server/agent'
import { clientIp } from '@/lib/server/client-ip'
import { HttpError, errorResponse, readJson } from '@/lib/server/http'
import { guestOnly } from '@/lib/server/route'
import { USER_KEY_HEADER, guestChat, userKey } from '@/lib/server/schemas'
import { GUEST_LIMITS } from '@/lib/limits'

/** A guest's message, streamed back like a signed-in chat; nothing is saved on the server. */
export const POST = guestOnly('guest.chat', async ({ env, guestId, request }) => {
  const parsed = guestChat.safeParse(await readJson(request))
  if (!parsed.success) throw new HttpError('bad_request')
  const rawKey = request.headers.get(USER_KEY_HEADER)
  let key: string | undefined
  if (rawKey !== null) {
    const checked = userKey.safeParse(rawKey)
    if (!checked.success) return errorResponse('user_key_invalid')
    key = checked.data
  }
  const cap = Number.parseInt(env.GUEST_SITE_DAILY_CAP, 10)
  const agent = await guestAgentFor(env, guestId)
  const result = await agent.guestTurn({
    text: parsed.data.text,
    history: parsed.data.history,
    userKey: key,
    ip: clientIp(request),
    siteCap: Number.isFinite(cap) && cap >= 0 ? cap : GUEST_LIMITS.siteDaily,
  })
  if (!result.ok) return errorResponse(result.code)
  return new Response(result.stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
  })
})
