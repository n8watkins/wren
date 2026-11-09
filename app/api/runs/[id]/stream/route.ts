import { agentFor } from '@/lib/server/agent'
import { errorResponse } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { runIdFrom } from '@/lib/server/runs'

/**
 * One of your runs as it happens (lib/research.ts RunStreamEvent): the whole
 * run now and after every step, until it ends. One request for the whole run,
 * so watching it doesn't use up the per-person request limit.
 */
export const GET = authed<{ id: string }>('runs.stream', async ({ env, session }, params) => {
  const agent = await agentFor(env, session.userId)
  const stream = await agent.watchResearch(runIdFrom(params))
  if (!stream) return errorResponse('run_not_found')
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
})
