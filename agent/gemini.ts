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

/*
 * Research's calls (agent/research.ts): planning the searches, reading a PDF,
 * writing the report, and the search backup. The agent takes one of the
 * person's daily research runs before a run starts (demo key).
 */

/** A part of a one-shot request: text, or a PDF the model reads. */
export type GeneratePart = { text: string } | { pdf: Uint8Array }

export interface GenerateOptions extends GeminiCallOptions {
  model: string
  fallbackModel?: string
  systemPrompt: string
  parts: GeneratePart[]
  /** Ask for JSON (the planner). */
  json?: boolean
  /** Aborted when the run is cancelled. */
  signal: AbortSignal
  /** How long one model may take for the whole answer. */
  timeoutMs?: number
}

const GENERATE_MS = 60_000

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** One whole (not streamed) answer, with the model fallback. Throws GeminiError. */
async function generate(options: GenerateOptions, googleSearch: boolean): Promise<{ text: string; web: { url: string; title: string }[] }> {
  return withFallback(options, 'research.model_failed', async (model) => {
    if (options.signal.aborted) throw new GeminiError('upstream_error')
    const attempt = new AbortController()
    const stop = () => attempt.abort()
    options.signal.addEventListener('abort', stop)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      attempt.abort()
    }, options.timeoutMs ?? GENERATE_MS)
    try {
      const response = await client(options).models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: options.parts.map((part) =>
              'pdf' in part ? { inlineData: { mimeType: 'application/pdf', data: toBase64(part.pdf) } } : { text: part.text }
            ),
          },
        ],
        config: {
          systemInstruction: options.systemPrompt,
          abortSignal: attempt.signal,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          ...(options.json ? { responseMimeType: 'application/json' } : {}),
          ...(googleSearch ? { tools: [{ googleSearch: {} }] } : {}),
        },
      })
      const web = (response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).flatMap((chunk) =>
        chunk.web?.uri ? [{ url: chunk.web.uri, title: chunk.web.title ?? '' }] : []
      )
      return { text: response.text ?? '', web }
    } catch (error) {
      // A cancelled run: the other model's attempt ends at its first line, without a request.
      if (options.signal.aborted) throw new GeminiError('upstream_error')
      throw timedOut ? new GeminiError('upstream_error', 504) : classifyGeminiError(error, options.keySource)
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', stop)
    }
  })
}

/** A whole answer as text: research planning, reading a PDF, writing the report. */
export async function generateText(options: GenerateOptions): Promise<string> {
  return (await generate(options, false)).text
}

/**
 * The search backup: Gemini answers with its Google Search tool on, and the
 * pages it found (the grounding sources) are the results. Their addresses are
 * Google redirect links that the safe fetcher follows to the page.
 */
export async function searchWithGoogle(
  options: Omit<GenerateOptions, 'parts' | 'json' | 'systemPrompt'> & { query: string }
): Promise<{ url: string; title: string }[]> {
  const { web } = await generate(
    { ...options, systemPrompt: 'Search the web for the query and answer in one short paragraph.', parts: [{ text: options.query }] },
    true
  )
  const seen = new Set<string>()
  return web.filter((page) => !seen.has(page.url) && seen.add(page.url))
}
