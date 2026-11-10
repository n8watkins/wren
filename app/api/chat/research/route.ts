import { agentFor } from '@/lib/server/agent'
import { clientIp } from '@/lib/server/client-ip'
import { HttpError, errorResponse, jsonResponse, readJson } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { chatResearchRequest } from '@/lib/server/schemas'

/**
 * "Research" from chat: starts a research run (one of today's, behind the
 * per-person and per-network counts) and adds the question and Wren's message
 * that shows the run to the chat, or to a new chat. The browser then watches
 * the run (GET /api/runs/:id/stream); its report lands in that message.
 */
export const POST = authed('chat.research', async ({ env, session, request }) => {
  const parsed = chatResearchRequest.safeParse(await readJson(request))
  if (!parsed.success) throw new HttpError('bad_request')
  const agent = await agentFor(env, session.userId)
  const started = await agent.startResearchInChat({ chatId: parsed.data.chatId, question: parsed.data.question, ip: clientIp(request) })
  if (!started.ok) return errorResponse(started.code)
  const { chat, userMessage, message, run } = started
  return jsonResponse({ chat, userMessage, message, run, usage: await agent.usage() }, { status: 201 })
})
