import { GeminiError, streamReply, type KeySource } from './gemini'
import type { Role } from './chats'
import { WREN_SYSTEM_PROMPT } from './persona'
import type { ErrorCode } from '../lib/errors'
import { log } from '../lib/log'
import type { ChatStreamEvent } from '../lib/stream-events'

type StartEvent = Extract<ChatStreamEvent, { t: 'start' }>

export interface AnswerStreamOptions {
  start: StartEvent
  apiKey: string
  keySource: KeySource
  model: string
  fallbackModel?: string
  history: { role: Role; text: string }[]
  baseUrl?: string
  controller: AbortController
  /** Called with the text so far while it streams (about once a second) and at the end. */
  save?: (text: string, status: 'done' | 'stopped' | 'error' | 'partial') => void
  /** Called when the answer failed before any text: give back what the meter took. */
  refund: () => Promise<void>
  finish: () => void
}

const SAVE_EVERY_MS = 1_000

/**
 * The streamed answer as NDJSON (lib/stream-events.ts): start, deltas, then
 * done or error. Cancelling the stream (Stop, or the tab closing) ends the
 * answer; what was written is kept by `save`.
 */
export function answerStream(options: AnswerStreamOptions): ReadableStream<Uint8Array> {
  const { controller, keySource, model } = options
  const encoder = new TextEncoder()
  const started = Date.now()
  return new ReadableStream<Uint8Array>({
    start: async (out) => {
      const send = (event: ChatStreamEvent) => {
        try {
          out.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          // The reader is gone (cancelled); the answer is still saved.
        }
      }
      send(options.start)
      let text = ''
      let savedAt = Date.now()
      try {
        for await (const chunk of streamReply({
          apiKey: options.apiKey,
          keySource,
          model,
          fallbackModel: options.fallbackModel,
          systemPrompt: WREN_SYSTEM_PROMPT,
          history: options.history,
          signal: controller.signal,
          baseUrl: options.baseUrl,
        })) {
          text += chunk
          send({ t: 'delta', text: chunk })
          if (Date.now() - savedAt > SAVE_EVERY_MS) {
            options.save?.(text, 'partial')
            savedAt = Date.now()
          }
        }
        const status = controller.signal.aborted ? 'stopped' : 'done'
        options.save?.(text, status)
        send({ t: 'done', status })
        log.info('chat.answer', { status: 200, chars: text.length, ms: Date.now() - started, model, keySource })
      } catch (error) {
        const code: ErrorCode = error instanceof GeminiError ? error.code : 'upstream_error'
        options.save?.(text, 'error')
        if (!text && code !== 'user_key_invalid' && code !== 'user_key_quota') await options.refund()
        send({ t: 'error', code })
        log.warn('chat.error', {
          code,
          model,
          keySource,
          upstreamStatus: error instanceof GeminiError ? error.upstreamStatus : undefined,
        })
      } finally {
        options.finish()
        try {
          out.close()
        } catch {
          // Already cancelled.
        }
      }
    },
    cancel: () => controller.abort(),
  })
}
