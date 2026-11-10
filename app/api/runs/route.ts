import { agentFor } from '@/lib/server/agent'
import { HttpError, errorResponse, jsonResponse, readJson } from '@/lib/server/http'
import { authed } from '@/lib/server/route'
import { clientIp } from '@/lib/server/client-ip'
import { researchRequest } from '@/lib/server/schemas'

/** Your research runs, newest first. */
export const GET = authed('runs.list', async ({ env, session }) => {
  const agent = await agentFor(env, session.userId)
  return jsonResponse({ runs: await agent.listResearch() })
})

/** Start a research run: one of today's runs, on the demo key; it carries on if you close the tab. */
export const POST = authed('runs.start', async ({ env, session, request }) => {
  const parsed = researchRequest.safeParse(await readJson(request))
  if (!parsed.success) throw new HttpError('bad_request')
  const agent = await agentFor(env, session.userId)
  const started = await agent.startResearch(parsed.data.question, clientIp(request))
  if (!started.ok) return errorResponse(started.code)
  return jsonResponse({ run: started.run, usage: await agent.usage() }, { status: 201 })
})
