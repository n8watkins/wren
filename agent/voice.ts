import { z } from 'zod'
import type { ChatMessage, ChatSummary, MessageStatus, Role } from './chats'
import { GeminiError, type KeySource, type LiveEvents, type LiveSession } from './gemini'
import { chooseKey } from './keys'
import type { ErrorCode } from '../lib/errors'
import { SIZE_LIMITS, VOICE_LIMITS, type UsageSnapshot } from '../lib/limits'
import { log } from '../lib/log'
import type { VoiceClientMessage, VoiceEndReason, VoiceServerMessage, VoiceState } from '../lib/voice'

/**
 * One voice session: the browser's socket on one side, Gemini Live on the
 * other, inside the person's agent. It relays audio both ways, writes each
 * spoken turn into the chat, and meters the time: seconds are taken from
 * today's allowance a chunk ahead of use, and what isn't used is given back.
 * Whatever ends the session (the person, the limit, silence, either side
 * dropping) closes both sockets, so Gemini is never left open.
 */

/** The browser's end of the socket, as the agent holds it. */
export interface VoiceClient {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export type TakeResult = 'ok' | 'voice_daily_limit' | 'voice_daily_limit_ip'

/** Today's voice allowance on the demo key (the person's and their network's). */
export interface VoiceMeter {
  take(seconds: number): Promise<TakeResult>
  giveBack(seconds: number): Promise<void>
  /** The person's seconds left today, not counting what this session holds. */
  secondsLeft(): number
  usage(): UsageSnapshot
}

export interface VoiceDeps {
  client: VoiceClient
  demoKey: string | undefined
  meter: VoiceMeter
  /** Opens Gemini Live with this key (agent/gemini.ts connectLive). */
  connect(key: { apiKey: string; keySource: KeySource }, events: LiveEvents): Promise<LiveSession>
  /** Saves a turn to the chat, starting the chat with the first one. */
  save(role: Role, text: string, status: MessageStatus): { chat: ChatSummary; message: ChatMessage }
  /** The chat the session is in, if it already exists. */
  chat: ChatSummary | null
  /** Called once, after both sockets are closed. */
  finished(): void
}

const clientMessage = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('start'), userKey: z.string().min(1).max(SIZE_LIMITS.apiKeyChars).optional() }),
  z.strictObject({ t: z.literal('text'), text: z.string().trim().min(1).max(SIZE_LIMITS.messageChars) }),
  z.strictObject({ t: z.literal('stop') }),
])

/** The person's own key errors, and the demo key's, as the voice error the person sees. */
function voiceError(error: unknown): ErrorCode {
  if (!(error instanceof GeminiError)) return 'voice_unavailable'
  if (error.code === 'upstream_error' || error.code === 'demo_unavailable') return 'voice_unavailable'
  return error.code
}

export class VoiceRelay {
  private phase: 'waiting' | 'connecting' | 'live' | 'ended' = 'waiting'
  private upstream?: LiveSession
  private keySource: KeySource = 'demo'
  /** Seconds taken from the meter so far, and when the session went live. */
  private taken = 0
  private startedAt = 0
  private lastActivity = 0
  private lastClientFrame = Date.now()
  private warned = false
  private ticker?: ReturnType<typeof setInterval>
  private taking = false
  private userText = ''
  private modelText = ''
  private modelTalking = false
  private state: VoiceState = 'connecting'

  constructor(private readonly deps: VoiceDeps) {
    // A browser that never sends `start`, or goes quiet, is gone.
    this.ticker = setInterval(() => void this.tick(), 1000)
  }

  /** A frame from the browser. */
  async receive(data: string | ArrayBuffer): Promise<void> {
    if (this.phase === 'ended') return
    this.lastClientFrame = Date.now()
    if (typeof data !== 'string') {
      if (data.byteLength === 0 || data.byteLength > VOICE_LIMITS.audioFrameBytes || data.byteLength % 2 !== 0) {
        return this.fail('bad_request')
      }
      if (this.phase === 'live') this.upstream?.sendAudio(new Uint8Array(data))
      return
    }
    if (data.length > VOICE_LIMITS.controlChars) return this.fail('bad_request')
    let parsed: VoiceClientMessage
    try {
      const result = clientMessage.safeParse(JSON.parse(data))
      if (!result.success) return this.fail('bad_request')
      parsed = result.data
    } catch {
      return this.fail('bad_request')
    }
    if (parsed.t === 'start') return this.start(parsed.userKey)
    if (parsed.t === 'stop') return this.end('stopped')
    if (this.phase !== 'live') return
    // A typed message while talking: saved like a spoken one, answered out loud.
    this.saveUserTurn()
    this.save('user', parsed.text, 'done')
    this.upstream?.sendText(parsed.text)
    this.lastActivity = Date.now()
    this.setState('thinking')
  }

  /** The browser's socket closed: end the session without a word to it. */
  clientGone(): void {
    void this.end('stopped', { quiet: true })
  }

  private async start(userKey: string | undefined): Promise<void> {
    if (this.phase !== 'waiting') return this.fail('bad_request')
    this.phase = 'connecting'
    const key = chooseKey(userKey, this.deps.demoKey)
    if (!key) return this.fail('voice_unavailable')
    this.keySource = key.keySource
    if (key.keySource === 'demo') {
      // The first chunk may be smaller near the end of the day's allowance.
      const chunk = Math.min(VOICE_LIMITS.chunkSeconds, this.deps.meter.secondsLeft())
      if (chunk <= 0) return this.fail('voice_daily_limit')
      const taken = await this.deps.meter.take(chunk)
      if (taken !== 'ok') return this.fail(taken)
      this.taken = chunk
    }
    // The browser left while the meter was being read.
    if (this.phase !== 'connecting') return this.refund()
    try {
      this.upstream = await this.deps.connect(key, this.events())
    } catch (error) {
      await this.refund()
      log.warn('voice.connect_failed', { code: error instanceof GeminiError ? error.code : 'unknown', keySource: key.keySource })
      return this.fail(voiceError(error))
    }
    // The browser left while Gemini was connecting.
    if (this.phase !== 'connecting') {
      this.upstream.close()
      return
    }
    this.phase = 'live'
    this.startedAt = Date.now()
    this.lastActivity = this.startedAt
    log.info('voice.started', { keySource: key.keySource })
    this.send({ t: 'ready', chat: this.deps.chat, secondsLeft: this.secondsLeft() })
    this.setState('listening')
    if (key.keySource === 'demo') this.send({ t: 'usage', usage: this.deps.meter.usage(), secondsLeft: this.secondsLeft() })
  }

  private events(): LiveEvents {
    return {
      audio: (pcm) => {
        this.modelStarts()
        this.lastActivity = Date.now()
        this.deps.client.send(pcm)
      },
      inputText: (text) => {
        this.userText += text
        this.lastActivity = Date.now()
        this.send({ t: 'interim', role: 'user', text: this.userText.trim() })
      },
      outputText: (text) => {
        this.modelStarts()
        this.modelText += text
        this.lastActivity = Date.now()
        this.send({ t: 'interim', role: 'model', text: this.modelText.trim() })
      },
      interrupted: () => {
        this.saveModelTurn('stopped')
        this.send({ t: 'interrupted' })
        this.setState('listening')
      },
      turnComplete: () => {
        this.saveUserTurn()
        this.saveModelTurn('done')
        this.setState('listening')
      },
      // Gemini ends a connection after about 10 minutes; sessions stop before then.
      goAway: () => void this.end('session_limit'),
      closed: (failure) => {
        if (failure) log.warn('voice.upstream_closed', { code: failure.code, upstreamStatus: failure.upstreamStatus, keySource: this.keySource })
        if (failure && failure.code !== 'upstream_error') void this.fail(voiceError(failure))
        else void this.end('upstream')
      },
    }
  }

  /** The first sound or word of Wren's turn: what the person said before it is final. */
  private modelStarts() {
    if (this.modelTalking) return
    this.modelTalking = true
    this.saveUserTurn()
    this.setState('talking')
  }

  private saveUserTurn() {
    const text = this.userText.trim()
    this.userText = ''
    if (text) this.save('user', text, 'done')
  }

  private saveModelTurn(status: MessageStatus) {
    const text = this.modelText.trim()
    this.modelText = ''
    this.modelTalking = false
    if (text) this.save('model', text, status)
  }

  private save(role: Role, text: string, status: MessageStatus) {
    const saved = this.deps.save(role, text.slice(0, SIZE_LIMITS.messageChars), status)
    this.deps.chat = saved.chat
    this.send({ t: 'message', chat: saved.chat, message: saved.message })
  }

  private setState(state: VoiceState) {
    if (state === this.state) return
    this.state = state
    this.send({ t: 'state', state })
  }

  private usedSeconds(now = Date.now()): number {
    return this.startedAt ? Math.ceil((now - this.startedAt) / 1000) : 0
  }

  /** Seconds left today for this session, or null on the person's own key. */
  private secondsLeft(): number | null {
    if (this.keySource !== 'demo') return null
    return Math.max(0, this.deps.meter.secondsLeft() + this.taken - this.usedSeconds())
  }

  /** Once a second: meter the time, and end sessions that ran out, went idle or lost the browser. */
  private async tick(): Promise<void> {
    const now = Date.now()
    if (this.phase === 'ended') return
    if (now - this.lastClientFrame > VOICE_LIMITS.clientSilentMs) return this.end('stopped', { quiet: true })
    if (this.phase !== 'live') return
    if (now - this.lastActivity > VOICE_LIMITS.idleSeconds * 1000) return this.end('idle')
    const used = this.usedSeconds(now)
    if (used >= VOICE_LIMITS.sessionSeconds) return this.end('session_limit')
    if (this.keySource !== 'demo' || this.taking) return
    if (used >= this.taken) {
      const chunk = Math.min(VOICE_LIMITS.chunkSeconds, this.deps.meter.secondsLeft())
      if (chunk <= 0) return this.end('limit')
      this.taking = true
      const result = await this.deps.meter.take(chunk)
      this.taking = false
      if (this.phase !== 'live') {
        if (result === 'ok') await this.deps.meter.giveBack(chunk)
        return
      }
      if (result !== 'ok') return this.end('limit')
      this.taken += chunk
      this.send({ t: 'usage', usage: this.deps.meter.usage(), secondsLeft: this.secondsLeft() })
    }
    const left = this.secondsLeft()
    if (!this.warned && left !== null && left <= VOICE_LIMITS.warnSeconds) {
      this.warned = true
      this.send({ t: 'usage', usage: this.deps.meter.usage(), secondsLeft: left })
    }
  }

  private send(message: VoiceServerMessage) {
    if (this.phase === 'ended') return
    try {
      this.deps.client.send(JSON.stringify(message))
    } catch {
      // The browser is gone; its close event ends the session.
    }
  }

  private async fail(code: ErrorCode): Promise<void> {
    this.send({ t: 'error', code })
    await this.end('stopped', { quiet: true })
  }

  /** Gives back every second taken that wasn't used (again: nothing). */
  private async refund(): Promise<void> {
    const unused = this.taken - Math.min(this.taken, this.usedSeconds())
    this.taken -= unused
    if (unused > 0) await this.deps.meter.giveBack(unused)
  }

  /** Ends the session once: saves what was said, closes both sides, gives back unused seconds. */
  async end(reason: VoiceEndReason, options: { quiet?: boolean } = {}): Promise<void> {
    if (this.phase === 'ended') return
    const wasLive = this.phase === 'live'
    clearInterval(this.ticker)
    this.upstream?.close()
    if (wasLive) {
      this.saveUserTurn()
      this.saveModelTurn('stopped')
    }
    const used = this.usedSeconds()
    if (!options.quiet) this.send({ t: 'end', reason })
    this.phase = 'ended'
    try {
      this.deps.client.close(1000, reason)
    } catch {
      // Already closed.
    }
    await this.refund()
    if (wasLive) log.info('voice.ended', { code: reason, count: used, keySource: this.keySource })
    this.deps.finished()
  }
}

/*
 * The handoff from the Worker (worker/voice.ts) to the person's agent: an
 * internal request that carries the checked ticket's chat, network and nonce.
 * Durable Objects can't be reached from outside except through the Worker,
 * which builds these headers itself and never passes the browser's along.
 */

const VOICE_AGENT_URL = 'https://wren-agent.internal/voice'

const HANDOFF = { chat: 'x-wren-voice-chat', ip: 'x-wren-voice-ip', nonce: 'x-wren-voice-nonce', expires: 'x-wren-voice-expires' } as const

export interface VoiceHandoff {
  chatId: string | null
  ip: string
  nonce: string
  expires: number
}

export function voiceHandoffRequest(handoff: VoiceHandoff): Request {
  return new Request(VOICE_AGENT_URL, {
    headers: {
      Upgrade: 'websocket',
      [HANDOFF.chat]: handoff.chatId ?? '',
      [HANDOFF.ip]: handoff.ip,
      [HANDOFF.nonce]: handoff.nonce,
      [HANDOFF.expires]: String(handoff.expires),
    },
  })
}

export function readVoiceHandoff(request: Request): VoiceHandoff | null {
  if (new URL(request.url).href !== VOICE_AGENT_URL) return null
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return null
  const nonce = request.headers.get(HANDOFF.nonce) ?? ''
  const expires = Number(request.headers.get(HANDOFF.expires))
  if (!nonce || !Number.isFinite(expires)) return null
  return { chatId: request.headers.get(HANDOFF.chat) || null, ip: request.headers.get(HANDOFF.ip) ?? 'unknown', nonce, expires }
}

/** The chat so far for Gemini Live: the newest turns within VOICE_LIMITS.historyChars, starting with the person. */
export function voiceHistory(history: { role: Role; text: string }[]): { role: Role; text: string }[] {
  const picked: { role: Role; text: string }[] = []
  let total = 0
  for (let i = history.length - 1; i >= 0; i--) {
    total += history[i].text.length
    if (total > VOICE_LIMITS.historyChars) break
    picked.unshift(history[i])
  }
  while (picked.length > 0 && picked[0].role !== 'user') picked.shift()
  return picked
}

/** Takes each ticket once, while it is valid; forgets expired ones. */
export class TicketBook {
  private readonly seen = new Map<string, number>()

  claim(nonce: string, expires: number, now = Date.now()): boolean {
    for (const [id, until] of this.seen) if (until < now) this.seen.delete(id)
    if (expires < now || this.seen.has(nonce)) return false
    this.seen.set(nonce, expires)
    return true
  }
}

/** Accepts the browser's socket and runs a relay on it. */
export function acceptVoice(build: (client: VoiceClient) => VoiceRelay): Response {
  const [browser, server] = Object.values(new WebSocketPair())
  server.accept()
  const relay = build({
    send: (data) => server.send(data),
    close: (code, reason) => server.close(code, reason),
  })
  // Binary frames may arrive as a Blob, which is read asynchronously: one queue keeps them in order.
  let frames = Promise.resolve()
  server.addEventListener('message', (event) => {
    const data: unknown = event.data
    frames = frames
      .then(async () => {
        if (typeof data === 'string' || data instanceof ArrayBuffer) return relay.receive(data)
        if (ArrayBuffer.isView(data)) return relay.receive(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
        if (data instanceof Blob) return relay.receive(await data.arrayBuffer())
      })
      .catch(() => relay.clientGone())
  })
  server.addEventListener('close', () => relay.clientGone())
  server.addEventListener('error', () => relay.clientGone())
  return new Response(null, { status: 101, webSocket: browser })
}
