import { agentFor } from '@/lib/server/agent'
import { jsonResponse } from '@/lib/server/http'
import { authed } from '@/lib/server/route'

/** Today's use of the demo key: messages, voice minutes and research runs. */
export const GET = authed('usage', async ({ env, session }) => {
  const agent = await agentFor(env, session.userId)
  return jsonResponse(await agent.usage())
})
