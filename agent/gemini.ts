import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai'
import type { Role } from './chats'

/**
 * The only module that talks to Gemini (eslint.config.mjs forbids importing
 * @google/genai anywhere else). WrenAgent calls it after the meter has taken
 * the unit, so no paid call can go around the meter.
 */

export type KeySource = 'demo' | 'user'

export type GeminiErrorCode =
  /** The person's own key was rejected. Never retried with the demo key. */
  | 'user_key_invalid'
  /** The person's own key is out of quota. */
  | 'user_key_quota'
  /** The demo key is out of quota or rate limited upstream. */
  | 'demo_busy'
  /** The demo key itself was rejected or isn't set: an operator problem. */
  | 'demo_unavailable'
  | 'upstream_error'

export class GeminiError extends Error {
  constructor(
    readonly code: GeminiErrorCode,
    readonly upstreamStatus?: number
  ) {
    super(code)
    this.name = 'GeminiError'
  }
}

export interface StreamReplyOptions {
  apiKey: string
  keySource: KeySource
  model: string
  systemPrompt: string
  history: { role: Role; text: string }[]
  signal: AbortSignal
  /** Tests point this at a local mock of the Gemini API (playwright.config.ts). */
  baseUrl?: string
}

/** Maps an upstream failure to what the person is told. */
export function classifyGeminiError(error: unknown, keySource: KeySource): GeminiError {
  const status = error instanceof ApiError ? error.status : undefined
  const message = error instanceof Error ? error.message : ''
  const badKey =
    status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(message))
  if (badKey) return new GeminiError(keySource === 'user' ? 'user_key_invalid' : 'demo_unavailable', status)
  if (status === 429) return new GeminiError(keySource === 'user' ? 'user_key_quota' : 'demo_busy', status)
  return new GeminiError('upstream_error', status)
}

/** Streams the model's answer as text chunks. Throws GeminiError. */
export async function* streamReply(options: StreamReplyOptions): AsyncGenerator<string> {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: options.baseUrl ? { baseUrl: options.baseUrl } : undefined,
  })
  let stream: AsyncGenerator<{ text?: string }>
  try {
    stream = await ai.models.generateContentStream({
      model: options.model,
      contents: options.history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
      config: {
        systemInstruction: options.systemPrompt,
        abortSignal: options.signal,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    })
  } catch (error) {
    if (options.signal.aborted) return
    throw classifyGeminiError(error, options.keySource)
  }
  try {
    for await (const chunk of stream) {
      if (chunk.text) yield chunk.text
    }
  } catch (error) {
    if (options.signal.aborted) return
    throw classifyGeminiError(error, options.keySource)
  }
}
