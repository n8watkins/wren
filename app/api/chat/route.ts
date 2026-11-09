import { agentFor } from '@/lib/server/agent'
import { clientIp } from '@/lib/server/client-ip'
import { HttpError, errorResponse, readJson } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { USER_KEY_HEADER, chatRequest, userKey } from '@/lib/server/schemas'

/**
 * Send a message (or regenerate the last answer) and stream the reply as
 * NDJSON (lib/stream-events.ts). The person's own Gemini key, if any, comes in
 * the X-Gemini-Key header and goes no further than this request.
 */
export const POST = authed('chat', async ({ env, session, request }) => {
  const parsed = chatRequest.safeParse(await readJson(request))
  if (!parsed.success) throw new HttpError('bad_request')

  const rawKey = request.headers.get(USER_KEY_HEADER)
  let key: string | undefined
  if (rawKey !== null) {
    const checked = userKey.safeParse(rawKey)
    if (!checked.success) return errorResponse('user_key_invalid')
    key = checked.data
  }

  const agent = await agentFor(env, session.userId)
  const result = await agent.chat({
    chatId: parsed.data.chatId,
    text: parsed.data.text,
    regenerate: parsed.data.regenerate === true,
    userKey: key,
    ip: clientIp(request),
  })
  if (!result.ok) return errorResponse(result.code)
  return new Response(result.stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
})
