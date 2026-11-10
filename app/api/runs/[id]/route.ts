import { agentFor } from '@/lib/server/agent'
import { errorResponse, jsonResponse } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { runIdFrom } from '@/lib/server/runs'

/** One of your runs: its steps, sources and report. */
export const GET = authed<{ id: string }>('runs.get', async ({ env, session }, params) => {
  const agent = await agentFor(env, session.userId)
  const run = await agent.getResearch(runIdFrom(params))
  return run ? jsonResponse({ run }) : errorResponse('run_not_found')
})
