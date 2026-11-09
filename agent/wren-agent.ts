import { Agent } from 'agents'
import {
  addMessage,
  createChat,
  createChatTables,
  deleteChat,
  dropLastAnswer,
  getChat,
  historyForModel,
  listChats,
  listMessages,
  titleFrom,
  updateMessage,
  type ChatMessage,
  type ChatSummary,
} from './chats'
import { GeminiError, streamReply } from './gemini'
import { chooseKey } from './keys'
import { createMeterTable, giveBack, tryTake, used } from './meter'
import { WREN_SYSTEM_PROMPT } from './persona'
import type { ErrorCode } from '../lib/errors'
import { DAILY_IP_LIMITS, DAILY_LIMITS, nextUtcMidnight, utcDay, type UsageSnapshot } from '../lib/limits'
import { log } from '../lib/log'
import { optionalSetting } from '../lib/secrets'
import type { ChatStreamEvent } from '../lib/stream-events'

/** What the API route hands over after verifying the session and the body. */
interface ChatTurnRequest {
  chatId?: string
  text?: string
  regenerate: boolean
  /** The person's own Gemini key, from this request only. Never stored. */
  userKey?: string
  /** CF-Connecting-IP, for the per-network daily limit. */
  ip: string
}

type ChatTurnResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; code: ErrorCode }

/** How often a partial answer is saved while it streams. */
const SAVE_EVERY_MS = 1_000

/**
 * One agent per signed-in person, named by their verified user id
 * (lib/server/agent.ts). It holds their chats and their daily meter in its own
 * SQLite database, and it is the only caller of Gemini.
 */
export class WrenAgent extends Agent<Cloudflare.Env> {
  private tablesReady = false
  /** Answers being written right now, by chat id, so Stop can end them. */
  private readonly inFlight = new Map<string, AbortController>()

  private get db(): SqlStorage {
    const sql = this.ctx.storage.sql
    if (!this.tablesReady) {
      createChatTables(sql)
      createMeterTable(sql)
      this.tablesReady = true
    }
    return sql
  }

  listChats(): ChatSummary[] {
    return listChats(this.db)
  }

  getChat(id: string): { chat: ChatSummary; messages: ChatMessage[]; answering: boolean } | null {
    const chat = getChat(this.db, id)
    if (!chat) return null
    return { chat, messages: listMessages(this.db, id), answering: this.inFlight.has(id) }
  }

  deleteChat(id: string): boolean {
    this.inFlight.get(id)?.abort()
    return deleteChat(this.db, id)
  }

  usage(): UsageSnapshot {
    const day = utcDay()
    return {
      chat: { used: used(this.db, day, 'chat'), limit: DAILY_LIMITS.chat },
      voiceMinutes: { used: used(this.db, day, 'voiceMinutes'), limit: DAILY_LIMITS.voiceMinutes },
      research: { used: used(this.db, day, 'research'), limit: DAILY_LIMITS.research },
      resetsAt: nextUtcMidnight(),
    }
  }

  stop(chatId: string): boolean {
    const controller = this.inFlight.get(chatId)
    controller?.abort()
    return controller !== undefined
  }

  async chat(request: ChatTurnRequest): Promise<ChatTurnResult> {
    const sql = this.db
    let chat = request.chatId ? getChat(sql, request.chatId) : null
    if (request.chatId && !chat) return { ok: false, code: 'chat_not_found' }
    if (request.regenerate && !chat) return { ok: false, code: 'nothing_to_regenerate' }
    if (!request.regenerate && !request.text) return { ok: false, code: 'bad_request' }
    if (chat && this.inFlight.has(chat.id)) return { ok: false, code: 'busy' }

    // The person's own key, or the demo key; never one in place of the other.
    const key = chooseKey(request.userKey, optionalSetting(this.env, 'GEMINI_API_KEY'))
    if (!key) return { ok: false, code: 'demo_unavailable' }
    const { apiKey, keySource } = key

    const day = utcDay()
    if (keySource === 'demo') {
      if (!tryTake(sql, day, 'chat', DAILY_LIMITS.chat)) return { ok: false, code: 'daily_limit' }
      const network = this.env.DAILY_COUNTER.getByName(`ip:${request.ip}`)
      if (!(await network.take('chat', DAILY_IP_LIMITS.chat))) {
        giveBack(sql, day, 'chat')
        return { ok: false, code: 'daily_limit_ip' }
      }
    }
    const refund = async () => {
      if (keySource !== 'demo') return
      giveBack(sql, day, 'chat')
      await this.env.DAILY_COUNTER.getByName(`ip:${request.ip}`).giveBack('chat')
    }

    // The awaits above let other requests in: check again before writing.
    if (chat && this.inFlight.has(chat.id)) {
      await refund()
      return { ok: false, code: 'busy' }
    }

    let userMessage: ChatMessage
    if (request.regenerate && chat) {
      const prompt = dropLastAnswer(sql, chat.id)
      if (!prompt) {
        await refund()
        return { ok: false, code: 'nothing_to_regenerate' }
      }
      userMessage = prompt
    } else {
      const text = request.text ?? ''
      chat ??= createChat(sql, titleFrom(text))
      userMessage = addMessage(sql, chat.id, 'user', text)
    }

    const history = historyForModel(listMessages(sql, chat.id))
    const answer = addMessage(sql, chat.id, 'model', '', 'stopped')
    const controller = new AbortController()
    this.inFlight.set(chat.id, controller)

    const chatRef = chat
    const usage = keySource === 'demo' ? this.usage() : null
    const model = this.env.GEMINI_MODEL
    const baseUrl = optionalSetting(this.env, 'GEMINI_BASE_URL')
    const encoder = new TextEncoder()
    const started = Date.now()

    const stream = new ReadableStream<Uint8Array>({
      start: async (out) => {
        const send = (event: ChatStreamEvent) => {
          try {
            out.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          } catch {
            // The reader is gone (cancelled); the answer is still saved.
          }
        }
        send({
          t: 'start',
          chat: chatRef,
          userMessage,
          messageId: answer.id,
          keySource,
          usage,
        })
        let text = ''
        let savedAt = Date.now()
        try {
          for await (const chunk of streamReply({
            apiKey,
            keySource,
            model,
            systemPrompt: WREN_SYSTEM_PROMPT,
            history,
            signal: controller.signal,
            baseUrl,
          })) {
            text += chunk
            send({ t: 'delta', text: chunk })
            if (Date.now() - savedAt > SAVE_EVERY_MS) {
              updateMessage(sql, answer.id, text, 'stopped')
              savedAt = Date.now()
            }
          }
          const status = controller.signal.aborted ? 'stopped' : 'done'
          if (text) updateMessage(sql, answer.id, text, status)
          else sql.exec('DELETE FROM messages WHERE id = ?', answer.id)
          send({ t: 'done', status })
          log.info('chat.answer', { status: 200, chars: text.length, ms: Date.now() - started, model, keySource })
        } catch (error) {
          const code = error instanceof GeminiError ? error.code : 'upstream_error'
          if (text) {
            updateMessage(sql, answer.id, text, 'error')
          } else {
            sql.exec('DELETE FROM messages WHERE id = ?', answer.id)
            if (code !== 'user_key_invalid' && code !== 'user_key_quota') await refund()
          }
          send({ t: 'error', code })
          log.warn('chat.error', {
            code,
            model,
            keySource,
            upstreamStatus: error instanceof GeminiError ? error.upstreamStatus : undefined,
          })
        } finally {
          this.inFlight.delete(chatRef.id)
          try {
            out.close()
          } catch {
            // Already cancelled.
          }
        }
      },
      // Closing the tab or pressing Stop ends the answer; what was written is kept.
      cancel: () => controller.abort(),
    })
    return { ok: true, stream }
  }
}
