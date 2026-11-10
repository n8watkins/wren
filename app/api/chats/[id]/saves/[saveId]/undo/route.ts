import { agentFor } from '@/lib/server/agent'
import { clientIp } from '@/lib/server/client-ip'
import { errorResponse, jsonResponse } from '@/lib/server/http'
import { pathId, userKeyFrom } from '@/lib/server/memory-schemas'
import { authed } from '@/lib/server/route'

/** Undo a fact Wren saved on its own in one of your chats: removes it, or puts back what it replaced. */
export const POST = authed<{ id: string; saveId: string }>('chats.undo_save', async ({ env, session, request }, params) => {
  const chatId = pathId(params.id, 'chat_not_found')
  const saveId = pathId(params.saveId, 'memory_not_found')
  const agent = await agentFor(env, session.userId)
  const result = await agent.memoryUndoSave(chatId, saveId, userKeyFrom(request), clientIp(request))
  return result.ok ? jsonResponse({ save: result.save }) : errorResponse(result.code)
})
