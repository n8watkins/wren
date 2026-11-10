import type { ChatMessage, ChatSummary } from '@/agent/chats'
import type { UsageSnapshot } from '@/lib/limits'
import type { RunDetail, RunStreamEvent, RunSummary } from '@/lib/research'
import { ApiError, failure, request } from './api'

/** The browser side of research runs (app/api/runs). */

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const runsApi = {
  list: () => request<{ runs: RunSummary[] }>('/api/runs').then((r) => r.runs),
  start: (question: string) => request<{ run: RunSummary; usage: UsageSnapshot }>('/api/runs', json({ question })),
  get: (id: string) => request<{ run: RunDetail }>(`/api/runs/${encodeURIComponent(id)}`).then((r) => r.run),
  /** "Research" from chat: the run, the chat (new if chatId is left out), your question and Wren's message for the run. */
  startInChat: (question: string, chatId: string | null) =>
    request<{ chat: ChatSummary; userMessage: ChatMessage; message: ChatMessage; run: RunSummary; usage: UsageSnapshot }>(
      '/api/chat/research',
      json({ question, chatId: chatId ?? undefined })
    ),
  cancel: (id: string) =>
    request<{ run: RunDetail }>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then((r) => r.run),
}

/**
 * A run as it happens: yields the whole run each time it changes, until it
 * ends or the server closes the stream (the caller opens another while the
 * run is still going). Throws ApiError before the stream starts.
 */
export async function* watchRun(id: string, signal: AbortSignal): AsyncGenerator<RunDetail> {
  let response: Response
  try {
    response = await fetch(`/api/runs/${encodeURIComponent(id)}/stream`, { credentials: 'same-origin', signal })
  } catch {
    if (signal.aborted) return
    throw new ApiError('network', "Couldn't reach Wren. Check your connection and try again.")
  }
  if (!response.ok || !response.body) throw await failure(response)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let event: RunStreamEvent
        try {
          event = JSON.parse(line) as RunStreamEvent
        } catch {
          continue
        }
        if (event.t === 'run') yield event.run
      }
    }
  } catch {
    if (signal.aborted) return
    throw new ApiError('network', 'The connection dropped.')
  } finally {
    reader.releaseLock()
  }
}
