import { agentFor } from '@/lib/server/agent'
import { HttpError, errorResponse, jsonResponse, readJson } from '@/lib/server/http'
import { idFrom, memoryPatch, userKeyFrom } from '@/lib/server/memory-schemas'
import { authed } from '@/lib/server/route'

/** Edit one of your memories. */
export const PATCH = authed<{ id: string }>('memory.update', async ({ env, session, request }, params) => {
  const id = idFrom(params)
  const parsed = memoryPatch.safeParse(await readJson(request))
  if (!parsed.success) throw new HttpError('bad_request')
  const agent = await agentFor(env, session.userId)
  const result = await agent.memoryUpdate(id, parsed.data, userKeyFrom(request))
  return result.ok ? jsonResponse({ memory: result.memory }) : errorResponse(result.code)
})

/** Delete one of your memories, with its search entry and its file. */
export const DELETE = authed<{ id: string }>('memory.delete', async ({ env, session }, params) => {
  const agent = await agentFor(env, session.userId)
  return (await agent.memoryDelete(idFrom(params))) ? jsonResponse({ deleted: true }) : errorResponse('memory_not_found')
})
