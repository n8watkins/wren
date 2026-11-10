import { agentFor } from '@/lib/server/agent'
import { errorResponse, jsonResponse } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { runIdFrom } from '@/lib/server/runs'

/** Stop one of your runs. A cancelled run still counts as one of today's. */
export const POST = authed<{ id: string }>('runs.cancel', async ({ env, session }, params) => {
  const agent = await agentFor(env, session.userId)
  const run = await agent.cancelResearch(runIdFrom(params))
  return run ? jsonResponse({ run }) : errorResponse('run_not_found')
})
