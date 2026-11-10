import type { ChatMessage, ChatSummary } from '../agent/chats'
import type { ErrorCode } from './errors'
import type { UsageSnapshot } from './limits'
import type { MessageMemory } from './memory'

/**
 * The voice socket (GET /api/voice, worker/voice.ts to agent/voice.ts),
 * shared by the agent and the browser. Audio goes as binary frames: 16 kHz
 * 16-bit little-endian mono PCM from the browser, 24 kHz from Wren. Anything
 * else is one JSON object per text frame.
 */

/** Wren's audio sample rate (Gemini Live's own); the mic's is 16 kHz (public/voice-capture.js). */
export const VOICE_OUTPUT_RATE = 24_000

/** From the browser. `start` comes first and only once; the key is the person's own, from this browser. */
export type VoiceClientMessage =
  | { t: 'start'; userKey?: string }
  /** A typed message while talking: Wren answers it out loud, and it is saved like a spoken one. */
  | { t: 'text'; text: string }
  | { t: 'stop' }

/** What Wren is doing, for the mark and the listening view. */
export type VoiceState = 'connecting' | 'listening' | 'thinking' | 'talking'

/** Why a session ended. */
export type VoiceEndReason =
  /** The person ended it. */
  | 'stopped'
  /** Today's minutes ran out mid-session. */
  | 'limit'
  /** Nobody said anything for a while. */
  | 'idle'
  /** The session reached its longest run (Gemini Live's connection limit). */
  | 'session_limit'
  /** The same person started voice somewhere else. */
  | 'replaced'
  /** Gemini Live closed the session or stopped answering. */
  | 'upstream'

/** From Wren. */
export type VoiceServerMessage =
  /** The session is live. `secondsLeft` is null on the person's own key (no daily limit). */
  | { t: 'ready'; chat: ChatSummary | null; secondsLeft: number | null }
  | { t: 'state'; state: VoiceState }
  /** The words of the turn being spoken so far, before it is saved. */
  | { t: 'interim'; role: 'user' | 'model'; text: string }
  /** A turn saved to the chat (the chat is new when the session started without one). */
  | { t: 'message'; chat: ChatSummary; message: ChatMessage }
  /** Memory's marks on a saved message changed (chips, "Saved to Memory"); null when it has none. */
  | { t: 'marks'; messageId: string; memory: MessageMemory | null }
  /** The person talked over Wren: stop playing what is queued. */
  | { t: 'interrupted' }
  /** Today's use, after the meter moved. */
  | { t: 'usage'; usage: UsageSnapshot; secondsLeft: number | null }
  | { t: 'end'; reason: VoiceEndReason }
  | { t: 'error'; code: ErrorCode }

/** Seconds of voice used, as the minutes the meter shows: tenths, rounded up, so any use shows. */
export function voiceMinutes(seconds: number): number {
  return Math.ceil(seconds / 6) / 10
}
