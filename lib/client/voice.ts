import type { ChatMessage, ChatSummary } from '@/agent/chats'
import { SIGN_IN_FIXES, errorMessage, isErrorCode } from '@/lib/errors'
import type { UsageSnapshot } from '@/lib/limits'
import { VOICE_OUTPUT_RATE, type VoiceEndReason, type VoiceServerMessage, type VoiceState } from '@/lib/voice'
import { ApiError, request } from './api'

/**
 * Voice in the browser: the mic through an AudioWorklet (public/voice-capture.js)
 * to 16 kHz PCM, the voice socket to the person's agent, and Wren's 24 kHz
 * audio played back through a small jitter buffer. One VoiceSession per
 * conversation out loud; stop() or any failure releases the mic and closes the
 * socket.
 */

export type VoiceStatus = VoiceState

export interface VoiceProblem {
  message: string
  /** Signing in fixes it. */
  signIn: boolean
  /** Informational (the session ended for a reason), not a failure. */
  info?: boolean
}

export interface VoiceHandlers {
  status(status: VoiceStatus): void
  /** How loud the mic is, 0 to 1, about ten times a second. */
  level(level: number): void
  interim(role: 'user' | 'model', text: string): void
  message(chat: ChatSummary, message: ChatMessage): void
  /** `secondsLeft` is null on the person's own key. */
  usage(usage: UsageSnapshot | null, secondsLeft: number | null): void
  /** The session is over; `problem` says why when the person didn't end it. */
  ended(problem: VoiceProblem | null): void
}

const CLIENT_PROBLEMS = {
  mic_denied: "Wren can't hear you: the microphone is blocked. Allow it for this site in your browser, then tap the mic again.",
  mic_missing: 'No microphone was found. Plug one in, or keep typing.',
  unsupported: "This browser can't do voice. Try a current Chrome, Edge, Firefox or Safari, or keep typing.",
  connection_lost: 'The voice connection dropped. Tap the mic to start again.',
} as const

/** Ticket age past which a new one is fetched before opening the socket (they last 60 s). */
const TICKET_FRESH_MS = 40_000

/** The last 3 s of speech (100 ms chunks) is held while the session connects. */
const EARLY_CHUNKS = 30

const END_NOTICES: Partial<Record<VoiceEndReason, string>> = {
  limit: 'That was the last of today’s voice minutes. Keep typing, or add your own Gemini key to talk more.',
  idle: 'Voice stopped after a minute of quiet. Tap the mic to talk again.',
  session_limit: 'Voice sessions last up to 9 minutes. Tap the mic to keep talking.',
  replaced: 'Voice moved to another tab or device.',
  upstream: 'Gemini ended the voice session. Tap the mic to start again.',
}

/** Plays 24 kHz PCM as it arrives, a little ahead so small gaps in the network don't break it up. */
class Playback {
  private next = 0
  private readonly playing = new Set<AudioBufferSourceNode>()
  private readonly output: GainNode

  constructor(
    private readonly context: AudioContext,
    private readonly onIdle: () => void
  ) {
    this.output = context.createGain()
    this.output.connect(context.destination)
  }

  get active(): boolean {
    return this.playing.size > 0
  }

  play(bytes: ArrayBuffer) {
    const pcm = new Int16Array(bytes)
    if (pcm.length === 0) return
    const buffer = this.context.createBuffer(1, pcm.length, VOICE_OUTPUT_RATE)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.output)
    // After a pause, start 120 ms out so the next chunks have time to arrive.
    const now = this.context.currentTime
    if (this.next < now + 0.02) this.next = now + 0.12
    source.start(this.next)
    this.next += buffer.duration
    this.playing.add(source)
    source.onended = () => {
      this.playing.delete(source)
      if (this.playing.size === 0) this.onIdle()
    }
  }

  /** Talked over: drop everything queued. */
  clear() {
    for (const source of this.playing) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Not started yet.
      }
    }
    this.playing.clear()
    this.next = 0
    this.onIdle()
  }
}

export class VoiceSession {
  private socket?: WebSocket
  private stream?: MediaStream
  private context?: AudioContext
  private playback?: Playback
  private serverState: VoiceStatus = 'connecting'
  private shown: VoiceStatus = 'connecting'
  private done = false
  private live = false
  /** Words spoken before the session was ready (people start talking as soon as they tap), sent once it is. */
  private early: ArrayBuffer[] = []

  constructor(private readonly handlers: VoiceHandlers) {}

  /** Opens the mic and the socket. Resolves when connecting has begun; everything after arrives through the handlers. */
  async start(options: { chatId: string | null; userKey: string | null }): Promise<void> {
    this.show('connecting')
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined' || typeof WebSocket === 'undefined') {
      return this.finish({ message: CLIENT_PROBLEMS.unsupported, signIn: false })
    }
    // Minutes and sign-in first, so nobody is asked for the mic only to be told no.
    let ticket = await this.ticket(options)
    if (ticket === null || this.done) return this.release()
    const ticketAt = Date.now()

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      const missing = name === 'NotFoundError' || name === 'OverconstrainedError'
      return this.finish({ message: missing ? CLIENT_PROBLEMS.mic_missing : CLIENT_PROBLEMS.mic_denied, signIn: false })
    }
    if (this.done) return this.release()
    // A ticket lasts a minute; the browser's mic prompt may have taken most of it.
    if (Date.now() - ticketAt > TICKET_FRESH_MS) {
      ticket = await this.ticket(options)
      if (ticket === null || this.done) return this.release()
    }

    try {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      await this.context.audioWorklet.addModule('/voice-capture.js')
      if (this.context.state === 'suspended') await this.context.resume()
    } catch {
      return this.finish({ message: CLIENT_PROBLEMS.unsupported, signIn: false })
    }
    if (this.done) return this.release()
    this.playback = new Playback(this.context, () => this.refreshStatus())
    const source = this.context.createMediaStreamSource(this.stream)
    const capture = new AudioWorkletNode(this.context, 'voice-capture')
    // The worklet only runs while its output is pulled; nothing is heard from it.
    const silent = this.context.createGain()
    silent.gain.value = 0
    source.connect(capture).connect(silent).connect(this.context.destination)
    capture.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      this.handlers.level(Math.min(1, event.data.level * 4))
      if (this.live && this.socket?.readyState === WebSocket.OPEN) this.socket.send(event.data.pcm)
      else if (!this.live) {
        this.early.push(event.data.pcm)
        if (this.early.length > EARLY_CHUNKS) this.early.shift()
      }
    }

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/api/voice?ticket=${encodeURIComponent(ticket)}`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => socket.send(JSON.stringify({ t: 'start', ...(options.userKey ? { userKey: options.userKey } : {}) }))
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data !== 'string') {
        this.playback?.play(event.data)
        this.refreshStatus()
        return
      }
      let message: VoiceServerMessage
      try {
        message = JSON.parse(event.data) as VoiceServerMessage
      } catch {
        return
      }
      this.onServer(message)
    }
    socket.onclose = () => {
      if (!this.done) this.finish({ message: CLIENT_PROBLEMS.connection_lost, signIn: false })
    }
  }

  /** A ticket for the voice socket, or null after telling the person why not. */
  private async ticket(options: { chatId: string | null; userKey: string | null }): Promise<string | null> {
    try {
      const { ticket } = await request<{ ticket: string }>('/api/voice/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: options.chatId ?? undefined, ownKey: Boolean(options.userKey) }),
      })
      return ticket
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : 'internal'
      const message = failure instanceof ApiError ? failure.message : errorMessage('internal')
      const signIn = code === 'unauthorized' || (isErrorCode(code) && SIGN_IN_FIXES.has(code))
      this.finish({ message: code === 'unauthorized' ? errorMessage('voice_sign_in') : message, signIn })
      return null
    }
  }

  /** A typed message while talking. Returns false when the session can't take it. */
  sendText(text: string): boolean {
    if (!this.live || this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ t: 'text', text }))
    return true
  }

  /** The person ended it. */
  stop() {
    if (this.done) return
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ t: 'stop' }))
    this.finish(null)
  }

  private onServer(message: VoiceServerMessage) {
    switch (message.t) {
      case 'ready':
        this.live = true
        for (const chunk of this.early.splice(0)) this.socket?.send(chunk)
        this.handlers.usage(null, message.secondsLeft)
        break
      case 'state':
        this.serverState = message.state
        this.refreshStatus()
        break
      case 'interim':
        this.handlers.interim(message.role, message.text)
        break
      case 'message':
        this.handlers.interim(message.message.role, '')
        this.handlers.message(message.chat, message.message)
        break
      case 'interrupted':
        this.playback?.clear()
        break
      case 'usage':
        this.handlers.usage(message.usage, message.secondsLeft)
        break
      case 'end': {
        const notice = END_NOTICES[message.reason]
        this.finish(notice ? { message: notice, signIn: false, info: true } : null)
        break
      }
      case 'error':
        this.finish({ message: errorMessage(message.code), signIn: SIGN_IN_FIXES.has(message.code) })
        break
    }
  }

  /** Wren is talking while its audio plays, even after the server has finished sending it. */
  private refreshStatus() {
    if (this.done) return
    this.show(this.playback?.active ? 'talking' : this.serverState === 'talking' ? 'thinking' : this.serverState)
  }

  private show(status: VoiceStatus) {
    if (status === this.shown) return
    this.shown = status
    this.handlers.status(status)
  }

  private finish(problem: VoiceProblem | null) {
    if (this.done) return
    this.done = true
    this.release()
    this.handlers.ended(problem)
  }

  private release() {
    this.done = true
    this.live = false
    this.early = []
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close(1000)
    this.socket = undefined
    void this.context?.close().catch(() => undefined)
    this.context = undefined
  }
}
