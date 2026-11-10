import { agentFor } from '@/lib/server/agent'
import { clientIp } from '@/lib/server/client-ip'
import { HttpError, errorResponse, jsonResponse, readJson } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { voiceTicketRequest } from '@/lib/server/schemas'
import { VOICE_LIMITS } from '@/lib/limits'
import { signVoiceTicket } from '@/lib/security/voice-ticket'

/**
 * A short-lived, single-use ticket to open the voice socket (GET /api/voice,
 * worker/voice.ts), for the signed-in person only, when they have minutes
 * left or bring their own key.
 */
export const POST = authed('voice.ticket', async ({ env, session, request }) => {
  const parsed = voiceTicketRequest.safeParse(await readJson(request))
  if (!parsed.success) throw new HttpError('bad_request')
  const agent = await agentFor(env, session.userId)
  const check = await agent.voiceCheck(parsed.data)
  if (!check.ok) return errorResponse(check.code)
  const ticket = await signVoiceTicket(env.BETTER_AUTH_SECRET, {
    userId: session.userId,
    chatId: parsed.data.chatId ?? null,
    ip: clientIp(request),
    expires: Date.now() + VOICE_LIMITS.ticketSeconds * 1000,
    nonce: crypto.randomUUID(),
  })
  return jsonResponse({ ticket })
})
