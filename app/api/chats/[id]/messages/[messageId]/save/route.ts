import { agentFor } from '@/lib/server/agent'
import { clientIp } from '@/lib/server/client-ip'
import { errorResponse, jsonResponse } from '@/lib/server/http'
import { pathId, userKeyFrom } from '@/lib/server/memory-schemas'
import { authed } from '@/lib/server/route'

/**
 * "Save to Memory" on a message in one of your chats: the message, read from
 * your own chat (never from the request), saved as a note. Saving a message
 * twice gets the memory already saved.
 */
export const POST = authed<{ id: string; messageId: string }>('chats.save_message', async ({ env, session, request }, params) => {
  const chatId = pathId(params.id, 'chat_not_found')
  const messageId = pathId(params.messageId, 'message_not_found')
  const agent = await agentFor(env, session.userId)
  const result = await agent.memorySaveMessage(chatId, messageId, userKeyFrom(request), clientIp(request))
  return result.ok ? jsonResponse({ memory: result.memory }) : errorResponse(result.code)
})
