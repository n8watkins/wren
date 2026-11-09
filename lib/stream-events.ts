import type { ChatMessage, ChatSummary } from '../agent/chats'
import type { ErrorCode } from './errors'
import type { UsageSnapshot } from './limits'

/**
 * The chat stream (POST /api/chat): one JSON object per line.
 * start: the chat (new or existing), the saved user message and the id the
 * answer will have; delta: more answer text; done or error: the end.
 */
export type ChatStreamEvent =
  | {
      t: 'start'
      chat: ChatSummary
      userMessage: ChatMessage
      messageId: string
      keySource: 'demo' | 'user'
      usage: UsageSnapshot | null
    }
  | { t: 'delta'; text: string }
  | { t: 'done'; status: 'done' | 'stopped' }
  | { t: 'error'; code: ErrorCode }

/** Splits a byte stream of NDJSON into events; skips anything malformed. */
export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          try {
            yield JSON.parse(line) as ChatStreamEvent
          } catch {
            // Not a whole event; ignore it.
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}
