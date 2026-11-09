import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai'
import type { Role } from './chats'
import { log } from '../lib/log'

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
  /** Tried once when `model` fails or stays silent before any text. */
  fallbackModel?: string
  /** How long a model may take to send its first text before it counts as failed. */
  firstTextMs?: number
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

/** A model that has sent no text by then is treated as down (some never answer at all). */
const FIRST_TEXT_MS = 20_000

/** Failures another model might not have: outages, silence, per-model quota. A bad key is a bad key everywhere. */
function worthAnotherModel(error: GeminiError): boolean {
  return error.code === 'upstream_error' || error.code === 'demo_busy' || error.code === 'user_key_quota'
}

/**
 * Streams the answer as text chunks. Tries `model`, then `fallbackModel` once
 * if the first failed before any text. Throws GeminiError.
 */
export async function* streamReply(options: StreamReplyOptions): AsyncGenerator<string> {
  const models = [options.model]
  if (options.fallbackModel && options.fallbackModel !== options.model) models.push(options.fallbackModel)
  let failure: GeminiError | undefined
  for (const model of models) {
    let sentText = false
    try {
      for await (const text of streamModel(options, model)) {
        sentText = true
        yield text
      }
      return
    } catch (error) {
      if (options.signal.aborted) return
      failure = error instanceof GeminiError ? error : classifyGeminiError(error, options.keySource)
      if (sentText || !worthAnotherModel(failure)) throw failure
      log.warn('chat.model_failed', { model, code: failure.code, upstreamStatus: failure.upstreamStatus, keySource: options.keySource })
    }
  }
  throw failure ?? new GeminiError('upstream_error')
}

/** One model's stream. Its own abort covers both Stop and a model that stays silent. */
async function* streamModel(options: StreamReplyOptions, model: string): AsyncGenerator<string> {
  const attempt = new AbortController()
  const stop = () => attempt.abort()
  options.signal.addEventListener('abort', stop)
  let silent = false
  const timer = setTimeout(() => {
    silent = true
    attempt.abort()
  }, options.firstTextMs ?? FIRST_TEXT_MS)
  const fail = (error: unknown) => (silent ? new GeminiError('upstream_error', 504) : classifyGeminiError(error, options.keySource))
  try {
    const ai = new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: options.baseUrl ? { baseUrl: options.baseUrl } : undefined,
    })
    let stream: AsyncGenerator<{ text?: string }>
    try {
      stream = await ai.models.generateContentStream({
        model,
        contents: options.history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
        config: {
          systemInstruction: options.systemPrompt,
          abortSignal: attempt.signal,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      })
    } catch (error) {
      throw fail(error)
    }
    try {
      for await (const chunk of stream) {
        if (chunk.text) {
          clearTimeout(timer)
          yield chunk.text
        }
      }
    } catch (error) {
      throw fail(error)
    }
    if (silent) throw fail(undefined)
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', stop)
  }
}

/*
 * Memory's calls (agent/memory.ts): embeddings, reading a PDF, and picking
 * lasting facts from what the person wrote. Each is one short request; the
 * agent takes a unit from the person's memory meter before it (demo key).
 */

export interface GeminiCallOptions {
  apiKey: string
  keySource: KeySource
  /** Tests point this at a local mock of the Gemini API. */
  baseUrl?: string
}

function client(options: GeminiCallOptions): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: options.baseUrl ? { baseUrl: options.baseUrl } : undefined,
  })
}

/** Runs `call` on `model`, then once on `fallbackModel` for failures another model might not have. */
async function withFallback<T>(
  options: GeminiCallOptions & { model: string; fallbackModel?: string },
  event: string,
  call: (model: string) => Promise<T>
): Promise<T> {
  const models = [options.model]
  if (options.fallbackModel && options.fallbackModel !== options.model) models.push(options.fallbackModel)
  let failure: GeminiError | undefined
  for (const model of models) {
    try {
      return await call(model)
    } catch (error) {
      failure = error instanceof GeminiError ? error : classifyGeminiError(error, options.keySource)
      if (!worthAnotherModel(failure)) throw failure
      log.warn(event, { model, code: failure.code, upstreamStatus: failure.upstreamStatus, keySource: options.keySource })
    }
  }
  throw failure ?? new GeminiError('upstream_error')
}

/** One text's embedding (gemini-embedding-2 takes its task in the text itself). */
export async function embedText(
  options: GeminiCallOptions & { model: string; text: string; dimensions: number; timeoutMs?: number }
): Promise<number[]> {
  try {
    const response = await client(options).models.embedContent({
      model: options.model,
      contents: options.text,
      config: { outputDimensionality: options.dimensions, abortSignal: AbortSignal.timeout(options.timeoutMs ?? 20_000) },
    })
    const values = response.embeddings?.[0]?.values
    if (!values || values.length !== options.dimensions) throw new GeminiError('upstream_error')
    return values
  } catch (error) {
    throw error instanceof GeminiError ? error : classifyGeminiError(error, options.keySource)
  }
}

/**
 * Asks the chat model for JSON matching `schema`, with a short timeout.
 * Returns the parsed value; a reply that isn't JSON is an upstream error.
 */
export async function generateJson(
  options: GeminiCallOptions & {
    model: string
    fallbackModel?: string
    systemPrompt: string
    parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[]
    schema: unknown
    timeoutMs?: number
  }
): Promise<unknown> {
  return withFallback(options, 'memory.model_failed', async (model) => {
    try {
      const response = await client(options).models.generateContent({
        model,
        contents: [{ role: 'user', parts: options.parts }],
        config: {
          systemInstruction: options.systemPrompt,
          responseMimeType: 'application/json',
          responseJsonSchema: options.schema,
          abortSignal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      })
      return JSON.parse(response.text ?? '') as unknown
    } catch (error) {
      if (error instanceof SyntaxError) throw new GeminiError('upstream_error')
      throw error instanceof GeminiError ? error : classifyGeminiError(error, options.keySource)
    }
  })
}
