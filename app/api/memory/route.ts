import { agentFor } from '@/lib/server/agent'
import { HttpError, errorResponse, jsonResponse, readJson } from '@/lib/server/http'
import { memoryListQuery, newMemory, userKeyFrom } from '@/lib/server/memory-schemas'
import { authed } from '@/lib/server/route'
import type { MemoryKind } from '@/lib/memory'

/** Your memories, newest first; with ?q= a search by words and meaning, with ?kind= one kind. */
export const GET = authed('memory.list', async ({ env, session, request }) => {
  const params = new URL(request.url).searchParams
  const parsed = memoryListQuery.safeParse({ q: params.get('q') ?? undefined, kind: params.get('kind') ?? undefined })
  if (!parsed.success) throw new HttpError('bad_request')
  const agent = await agentFor(env, session.userId)
  const list = await agent.memoryList({
    query: parsed.data.q,
    kind: parsed.data.kind as MemoryKind | undefined,
    userKey: userKeyFrom(request),
  })
  return jsonResponse(list)
})

/** Save a note, or a link (its address and an optional title; Wren doesn't fetch it). */
export const POST = authed('memory.create', async ({ env, session, request }) => {
  const parsed = newMemory.safeParse(await readJson(request))
  if (!parsed.success) throw new HttpError('bad_request')
  const key = userKeyFrom(request)
  const agent = await agentFor(env, session.userId)
  const body = parsed.data
  const result =
    body.kind === 'note'
      ? await agent.memoryAddNote(body.text, key)
      : await agent.memoryAddLink({ url: body.url, title: body.title ?? '' }, key)
  return result.ok ? jsonResponse({ memory: result.memory }, { status: 201 }) : errorResponse(result.code)
})
