import { agentFor } from '@/lib/server/agent'
import { HttpError, errorResponse, jsonResponse, readBytes } from '@/lib/server/http'
import { FILE_NAME_HEADER, fileName, userKeyFrom } from '@/lib/server/memory-schemas'
import { authed } from '@/lib/server/route'
import { MEMORY_LIMITS } from '@/lib/memory'

/**
 * Save a text, Markdown or PDF file: the body is the file itself (at most
 * 5 MB, cut off as soon as it goes over) and X-File-Name its URL-encoded name.
 */
export const POST = authed('memory.upload', async ({ env, session, request }) => {
  let name: string
  try {
    name = decodeURIComponent(request.headers.get(FILE_NAME_HEADER) ?? '')
  } catch {
    throw new HttpError('bad_request')
  }
  const parsed = fileName.safeParse(name)
  if (!parsed.success) throw new HttpError('bad_request')
  const key = userKeyFrom(request)
  const bytes = await readBytes(request, MEMORY_LIMITS.fileMaxBytes, 'memory_file_too_large')
  const agent = await agentFor(env, session.userId)
  const result = await agent.memoryAddFile(parsed.data, bytes.buffer, key)
  return result.ok ? jsonResponse({ memory: result.memory }, { status: 201 }) : errorResponse(result.code)
})
