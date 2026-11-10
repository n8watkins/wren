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
  /** Called once the answer is over (done, stopped or failed), before `after` runs. */
  finish: () => void
  /**
   * Runs after `start` is sent and before the model is called: more system
   * prompt (recalled memories) and events to send first. A failure here is
   * logged and the answer goes on without it.
   */
  prepare?: () => Promise<{ system?: string; events?: ChatStreamEvent[] }>
  /**
   * Runs after a finished answer (not a stopped or failed one) and after
   * `finish`, so the chat is free again: its events (Wren's saves) are sent
   * before the stream closes. A failure here is logged and ignored.
   */
  after?: () => Promise<ChatStreamEvent[]>
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
      let systemPrompt = WREN_SYSTEM_PROMPT
      if (options.prepare) {
        try {
          const prepared = await options.prepare()
          if (prepared.system) systemPrompt = `${WREN_SYSTEM_PROMPT}\n\n${prepared.system}`
          for (const event of prepared.events ?? []) send(event)
        } catch {
          log.warn('chat.prepare_failed', { code: 'internal' })
        }
      }
      let text = ''
      let savedAt = Date.now()
      let finished: 'done' | 'stopped' | 'error' = 'error'
      try {
        for await (const chunk of streamReply({
          apiKey: options.apiKey,
          keySource,
          model,
          fallbackModel: options.fallbackModel,
          systemPrompt,
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
        finished = status
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
      }
      if (finished === 'done' && text && options.after) {
        try {
          for (const event of await options.after()) send(event)
        } catch {
          log.warn('chat.after_failed', { code: 'internal' })
        }
      }
      try {
        out.close()
      } catch {
        // Already cancelled.
      }
    },
    cancel: () => controller.abort(),
  })
}
