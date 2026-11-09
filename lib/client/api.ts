import type { ChatMessage, ChatSummary } from '@/agent/chats'
import { errorMessage, isErrorCode, type ErrorCode } from '@/lib/errors'
import type { UsageSnapshot } from '@/lib/limits'
import { readChatStream, type ChatStreamEvent } from '@/lib/stream-events'

/** The browser side of the API. The user's own key, if any, rides in a header per call. */

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network',
    message: string
  ) {
    super(message)
  }
}

async function failure(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (isErrorCode(body.error)) return new ApiError(body.error, errorMessage(body.error))
  } catch {
    // Not JSON.
  }
  return new ApiError('internal', errorMessage('internal'))
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError('network', "Couldn't reach Wren. Check your connection and try again.")
  }
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

export const api = {
  listChats: () => request<{ chats: ChatSummary[] }>('/api/chats').then((r) => r.chats),
  getChat: (id: string) =>
    request<{ chat: ChatSummary; messages: ChatMessage[]; answering: boolean }>(`/api/chats/${encodeURIComponent(id)}`),
  deleteChat: (id: string) => request<{ deleted: boolean }>(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  usage: () => request<UsageSnapshot>('/api/usage'),
  stop: (chatId: string) =>
    request<{ stopped: boolean }>('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId }),
    }),
}

export interface SendOptions {
  chatId?: string
  text?: string
  regenerate?: boolean
  userKey?: string | null
  signal: AbortSignal
}

/** Sends a message and yields the streamed answer's events. Throws ApiError before the stream starts. */
export async function* sendMessage(options: SendOptions): AsyncGenerator<ChatStreamEvent> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.userKey) headers['X-Gemini-Key'] = options.userKey
  let response: Response
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ chatId: options.chatId, text: options.text, regenerate: options.regenerate || undefined }),
      signal: options.signal,
    })
  } catch {
    if (options.signal.aborted) return
    throw new ApiError('network', "Couldn't reach Wren. Check your connection and try again.")
  }
  if (!response.ok || !response.body) throw await failure(response)
  try {
    yield* readChatStream(response.body)
  } catch {
    if (options.signal.aborted) return
    throw new ApiError('network', 'The connection dropped before the answer finished.')
  }
}
