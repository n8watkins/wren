import { getAgentByName } from 'agents/routing'
import { voiceHandoffRequest } from '../agent/voice'
import { ERRORS, type ErrorCode } from '../lib/errors'
import { clientIp } from '../lib/server/client-ip'
import { verifyVoiceTicket, voiceOriginAllowed } from '../lib/security/voice-ticket'

/**
 * GET /api/voice: the voice socket. Next routes can't upgrade a WebSocket, so
 * the Worker takes it before OpenNext. The browser first gets a ticket from
 * POST /api/voice/ticket (a verified session, burst limits, today's minutes);
 * here the page's origin, the ticket's signature, expiry and network, and the
 * burst limits are checked again, then the socket goes to that person's agent
 * (agent/voice.ts), which takes each ticket once.
 */
export const VOICE_PATH = '/api/voice'

function refuse(code: ErrorCode): Response {
  return Response.json({ error: code, message: ERRORS[code].message }, { status: ERRORS[code].status, headers: { 'Cache-Control': 'no-store' } })
}

export async function handleVoice(request: Request, env: CloudflareEnv): Promise<Response> {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return refuse('bad_request')
  // Browsers always send Origin with a WebSocket; another site's page can't open Wren's.
  if (!voiceOriginAllowed(request.headers.get('Origin'), env)) return refuse('unauthorized')
  const ticket = await verifyVoiceTicket(env.BETTER_AUTH_SECRET, new URL(request.url).searchParams.get('ticket') ?? '')
  const ip = clientIp(request)
  if (!ticket || ticket.ip !== ip) return refuse('voice_ticket_invalid')
  const [user, network] = await Promise.all([
    env.USER_BURST_LIMITER.limit({ key: `user:${ticket.userId}` }),
    env.IP_BURST_LIMITER.limit({ key: `ip:${ip}` }),
  ])
  if (!user.success || !network.success) return refuse('rate_limited')
  const agent = await getAgentByName(env.WREN_AGENT, ticket.userId)
  return agent.fetch(voiceHandoffRequest({ chatId: ticket.chatId, ip, nonce: ticket.nonce, expires: ticket.expires }))
}
