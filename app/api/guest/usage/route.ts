import { guestAgentFor } from '@/lib/server/agent'
import { jsonResponse } from '@/lib/server/http'
import { guestOnly } from '@/lib/server/route'

/** A guest's messages today. */
export const GET = guestOnly('guest.usage', async ({ env, guestId }) => {
  const agent = await guestAgentFor(env, guestId)
  return jsonResponse(await agent.guestUsage())
})
