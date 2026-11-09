import { agentFor } from '@/lib/server/agent'
import { HttpError, errorResponse, jsonResponse } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { chatId } from '@/lib/server/schemas'

function idFrom(params: { id: string }): string {
  const parsed = chatId.safeParse(params.id)
  if (!parsed.success) throw new HttpError('chat_not_found')
  return parsed.data
}

/** One of your chats with its messages. */
export const GET = authed<{ id: string }>('chats.get', async ({ env, session }, params) => {
  const agent = await agentFor(env, session.userId)
  const chat = await agent.getChat(idFrom(params))
  return chat ? jsonResponse(chat) : errorResponse('chat_not_found')
})

/** Delete one of your chats and everything in it. */
export const DELETE = authed<{ id: string }>('chats.delete', async ({ env, session }, params) => {
  const agent = await agentFor(env, session.userId)
  return (await agent.deleteChat(idFrom(params))) ? jsonResponse({ deleted: true }) : errorResponse('chat_not_found')
})
