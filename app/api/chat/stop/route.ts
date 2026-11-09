import { agentFor } from '@/lib/server/agent'
import { HttpError, jsonResponse, readJson } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { stopRequest } from '@/lib/server/schemas'

/** Stop the answer being written in one of your chats; what was written is kept. */
export const POST = authed('chat.stop', async ({ env, session, request }) => {
  const parsed = stopRequest.safeParse(await readJson(request))
  if (!parsed.success) throw new HttpError('bad_request')
  const agent = await agentFor(env, session.userId)
  return jsonResponse({ stopped: await agent.stop(parsed.data.chatId) })
})
