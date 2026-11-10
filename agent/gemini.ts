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
  /** Tried once when `model` fails or stays silent before any text, or breaks off after it. */
  fallbackModel?: string
  /** How long a model may take to send its first text before it counts as failed (tests shorten it). */
  firstTextMs?: FirstTextWait
  systemPrompt: string
  history: { role: Role; text: string }[]
  signal: AbortSignal
  /** Tests point this at a local mock of the Gemini API (playwright.config.ts). */
  baseUrl?: string
  /**
   * The answer broke off and starts again from the beginning: drop the text
   * streamed so far. Called before the new attempt's first chunk.
   */
  onRestart?: () => void
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

/**
 * How long a model may take to send its first text before it is treated as
 * down (some never answer at all). The first model gets 10 s before chat
 * switches to the fallback: the daily model check measured normal starts of 2
 * to 9 s on gemini-3.5-flash-lite, so 10 s clears every one of them while a
 * stalled answer moves on 10 s sooner than it used to. The last model (the
 * fallback, or the only one) keeps 20 s, as there is nothing left to switch to
 * and gemini-3.1-flash-lite took up to 20 s in the same check.
 */
export interface FirstTextWait {
  /** The first model, when a fallback is there to take over. */
  beforeFallback: number
  /** The last model tried. */
  last: number
}

export const FIRST_TEXT_MS: FirstTextWait = { beforeFallback: 10_000, last: 20_000 }

/** Failures another model might not have: outages, silence, per-model quota. A bad key is a bad key everywhere. */
function worthAnotherModel(error: GeminiError): boolean {
  return error.code === 'upstream_error' || error.code === 'demo_busy' || error.code === 'user_key_quota'
}

/**
 * Streams the answer as text chunks. Tries `model`, then `fallbackModel` once
 * if the first failed before any text. An answer that breaks off after it
 * started (Gemini's mid-stream 503 "overloaded") starts again once from the
 * beginning, on the fallback (or the same model when it is the last one):
 * `onRestart` tells the caller to drop the partial text. A second break, or
 * one that another model can't fix (a bad key), throws. Throws GeminiError.
 */
export async function* streamReply(options: StreamReplyOptions): AsyncGenerator<string> {
  const models = [options.model]
  if (options.fallbackModel && options.fallbackModel !== options.model) models.push(options.fallbackModel)
  let failure: GeminiError | undefined
  let restarted = false
  const wait = options.firstTextMs ?? FIRST_TEXT_MS
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    let sentText = false
    try {
      for await (const text of streamModel(options, model, i < models.length - 1 ? wait.beforeFallback : wait.last)) {
        sentText = true
        yield text
      }
      return
    } catch (error) {
      if (options.signal.aborted) return
      failure = error instanceof GeminiError ? error : classifyGeminiError(error, options.keySource)
      if (!worthAnotherModel(failure)) throw failure
      if (sentText) {
        if (restarted) throw failure
        restarted = true
        log.warn('chat.answer_restarted', { model, code: failure.code, upstreamStatus: failure.upstreamStatus, keySource: options.keySource })
        options.onRestart?.()
        // The last model starts again itself; otherwise the next one takes over.
        if (i === models.length - 1) i--
        continue
      }
      log.warn('chat.model_failed', { model, code: failure.code, upstreamStatus: failure.upstreamStatus, keySource: options.keySource })
    }
  }
  throw failure ?? new GeminiError('upstream_error')
}

/** One model's stream. Its own abort covers both Stop and a model that stays silent. */
async function* streamModel(options: StreamReplyOptions, model: string, firstTextMs: number): AsyncGenerator<string> {
  const attempt = new AbortController()
  const stop = () => attempt.abort()
  options.signal.addEventListener('abort', stop)
  let silent = false
  const timer = setTimeout(() => {
    silent = true
    attempt.abort()
  }, firstTextMs)
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
 * Research's calls (agent/research.ts): planning the searches, reading a PDF
 * and writing the report. The agent takes one of the person's daily research
 * runs before a run starts (demo key).
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

/** A whole (not streamed) answer as text, with the model fallback: research planning, reading a PDF, writing the report. Throws GeminiError. */
export async function generateText(options: GenerateOptions): Promise<string> {
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
        },
      })
      return response.text ?? ''
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

/*
 * Voice (agent/voice.ts): a Gemini Live session over a WebSocket from the
 * person's agent. The key goes in a header, never the URL. The agent takes
 * voice seconds from the meter before it connects and while the session runs.
 */

const LIVE_HOST = 'https://generativelanguage.googleapis.com'
const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

/** What a Live session reports, in the order Gemini sends it. */
export interface LiveEvents {
  /** 24 kHz 16-bit PCM of Wren speaking. */
  audio(pcm: Uint8Array): void
  /** More words of what the person is saying. */
  inputText(text: string): void
  /** More words of what Wren is saying. */
  outputText(text: string): void
  /** The person talked over Wren; what was being said is cut off. */
  interrupted(): void
  /** Wren finished its turn. */
  turnComplete(): void
  /** Gemini will close the connection soon (it lasts about 10 minutes). */
  goAway(): void
  /** Wren wants one of the session's tools run; answer each with sendToolResponse. */
  toolCall(calls: LiveToolCall[]): void
  /** Calls Gemini no longer wants answered (the person talked over Wren). */
  toolCancelled(ids: string[]): void
  /** The connection closed; `failure` when it wasn't closed by us. */
  closed(failure?: GeminiError): void
}

export interface LiveSession {
  /** 16 kHz 16-bit PCM from the mic. */
  sendAudio(pcm: Uint8Array): void
  /** A typed message; Wren answers it out loud. */
  sendText(text: string): void
  /** The result of a tool call, as `{ output }` or `{ error }`. */
  sendToolResponse(response: LiveToolResponse): void
  close(): void
}

/** A function the Live model may call (a FunctionDeclaration; types in Gemini's schema subset). */
export interface LiveTool {
  name: string
  description: string
  parameters: { type: 'OBJECT'; properties: Record<string, { type: 'STRING'; description: string }>; required: string[] }
}

export interface LiveToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface LiveToolResponse {
  id: string
  name: string
  response: { output: unknown } | { error: string }
}

export interface LiveOptions {
  apiKey: string
  keySource: KeySource
  model: string
  systemPrompt: string
  /** The chat so far, given as context without asking for an answer. */
  history: { role: Role; text: string }[]
  /** Functions the model may call during the session (sync: it waits for each answer). */
  tools?: LiveTool[]
  /** How long Gemini may take to accept the session. */
  setupMs: number
  /** Tests point this at a local mock of the Gemini API. */
  baseUrl?: string
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** A close Gemini sends instead of an HTTP status (a bad key closes with 1007). */
export function classifyLiveClose(code: number, reason: string, keySource: KeySource): GeminiError {
  if (/api[ _-]?key|permission|unauthenticated/i.test(reason)) {
    return new GeminiError(keySource === 'user' ? 'user_key_invalid' : 'demo_unavailable', code)
  }
  if (/quota|exhausted|rate limit/i.test(reason)) return new GeminiError(keySource === 'user' ? 'user_key_quota' : 'demo_busy', code)
  return new GeminiError('upstream_error', code)
}

interface LiveServerMessage {
  setupComplete?: object
  goAway?: object
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] }
  toolCallCancellation?: { ids?: string[] }
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string } }[] }
    inputTranscription?: { text?: string }
    outputTranscription?: { text?: string }
    interrupted?: boolean
    turnComplete?: boolean
  }
}

/**
 * Opens a Live session and resolves once Gemini has accepted it (and has the
 * chat so far). Throws GeminiError when it can't.
 */
export async function connectLive(options: LiveOptions, events: LiveEvents): Promise<LiveSession> {
  const url = `${options.baseUrl ?? LIVE_HOST}${LIVE_PATH}`
  let response: Response
  try {
    response = await fetch(url, { headers: { Upgrade: 'websocket', 'x-goog-api-key': options.apiKey } })
  } catch {
    throw new GeminiError('upstream_error')
  }
  if (!response.webSocket) {
    const message = await response.text().catch(() => '')
    throw classifyGeminiError(new ApiError({ message, status: response.status }), options.keySource)
  }
  const socket = response.webSocket
  socket.accept()

  let ready = false
  let closedByUs = false
  let settle: { resolve: () => void; reject: (error: GeminiError) => void } | undefined
  const accepted = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
  const timer = setTimeout(() => {
    settle?.reject(new GeminiError('upstream_error', 504))
    closedByUs = true
    socket.close(1000, 'setup timed out')
  }, options.setupMs)

  const session: LiveSession = {
    sendAudio: (pcm) => send({ realtimeInput: { audio: { data: toBase64(pcm), mimeType: 'audio/pcm;rate=16000' } } }),
    sendText: (text) => send({ realtimeInput: { text } }),
    sendToolResponse: (response) => send({ toolResponse: { functionResponses: [response] } }),
    close: () => {
      if (closedByUs) return
      closedByUs = true
      clearTimeout(timer)
      try {
        socket.close(1000, 'done')
      } catch {
        // Already closed.
      }
    },
  }
  function send(message: unknown) {
    if (!ready || closedByUs) return
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // The close event reports it.
    }
  }

  const decoder = new TextDecoder()
  // Gemini sends JSON in binary frames, which may arrive as a Blob; reading one
  // is async, so frames are handled in order through one queue.
  const frameText = async (data: unknown): Promise<string> => {
    if (typeof data === 'string') return data
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return decoder.decode(data)
    if (data instanceof Blob) return data.text()
    return ''
  }
  let frames = Promise.resolve()
  socket.addEventListener('message', (event) => {
    frames = frames.then(async () => handle(await frameText(event.data))).catch(() => undefined)
  })
  const handle = (text: string) => {
    let message: LiveServerMessage
    try {
      message = JSON.parse(text) as LiveServerMessage
    } catch {
      return
    }
    if (message.setupComplete && !ready) {
      ready = true
      clearTimeout(timer)
      if (options.history.length) {
        socket.send(
          JSON.stringify({
            clientContent: { turns: options.history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })), turnComplete: true },
          })
        )
      }
      settle?.resolve()
      return
    }
    if (message.goAway) events.goAway()
    if (ready && message.toolCall?.functionCalls?.length) {
      const calls = message.toolCall.functionCalls
        .filter((call) => call.id && call.name)
        .map((call) => ({ id: call.id!, name: call.name!, args: call.args ?? {} }))
      if (calls.length) events.toolCall(calls)
    }
    if (ready && message.toolCallCancellation?.ids?.length) events.toolCancelled(message.toolCallCancellation.ids)
    const content = message.serverContent
    if (!content || !ready) return
    // One message can carry several of these at once.
    if (content.inputTranscription?.text) events.inputText(content.inputTranscription.text)
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) events.audio(fromBase64(part.inlineData.data))
    }
    if (content.outputTranscription?.text) events.outputText(content.outputTranscription.text)
    if (content.interrupted) events.interrupted()
    if (content.turnComplete) events.turnComplete()
  }
  socket.addEventListener('close', (event) => {
    clearTimeout(timer)
    // After the frames before it.
    frames = frames.then(() => {
      const failure = classifyLiveClose(event.code, event.reason, options.keySource)
      if (!ready) settle?.reject(failure)
      else events.closed(closedByUs ? undefined : failure)
      closedByUs = true
    })
  })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    if (!ready) settle?.reject(new GeminiError('upstream_error'))
  })

  socket.send(
    JSON.stringify({
      setup: {
        model: `models/${options.model}`,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: options.systemPrompt }] },
        // "Wren" is not a common word; without the hint it is often heard as another name.
        inputAudioTranscription: { customVocabulary: ['Wren'] },
        outputAudioTranscription: {},
        // Keeps a long conversation inside the model's context instead of ending the session.
        contextWindowCompression: { slidingWindow: {} },
        ...(options.tools?.length ? { tools: [{ functionDeclarations: options.tools }] } : {}),
        ...(options.history.length ? { historyConfig: { initialHistoryInClientContent: true } } : {}),
      },
    })
  )
  await accepted
  return session
}
