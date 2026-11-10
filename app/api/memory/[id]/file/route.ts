import { agentFor } from '@/lib/server/agent'
import { errorResponse } from '@/lib/server/http'
import { idFrom } from '@/lib/server/memory-schemas'
import { authed } from '@/lib/server/route'

/** Download a file you saved to Memory. Always a download, never rendered in the page. */
export const GET = authed<{ id: string }>('memory.file', async ({ env, session }, params) => {
  const agent = await agentFor(env, session.userId)
  const found = await agent.memoryFile(idFrom(params))
  if (!found?.memory.file) return errorResponse('memory_not_found')
  const { name, type } = found.memory.file
  return new Response(found.bytes, {
    headers: {
      'Content-Type': type === 'application/pdf' ? type : `${type}; charset=utf-8`,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
