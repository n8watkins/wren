import { agentFor } from '@/lib/server/agent'
import { jsonResponse } from '@/lib/server/http'
import { authed } from '@/lib/server/route'

/** Your chats, most recent first. */
export const GET = authed('chats.list', async ({ env, session }) => {
  const agent = await agentFor(env, session.userId)
  return jsonResponse({ chats: await agent.listChats() })
})
