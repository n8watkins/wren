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
import { answerStream } from './answer-stream'
import { ChatMemory } from './chat-memory'
import { MemoryEngine, type MemoryList, type MemoryResult } from './memory'
import { memoryAi } from './memory-ai'
import { sqliteStore, vectorizeStore } from './memory-vectors'
import { chooseKey } from './keys'
import { createMeterTable, giveBack, tryTake, used } from './meter'
import type { ErrorCode } from '../lib/errors'
import { DAILY_IP_LIMITS, DAILY_LIMITS, GUEST_LIMITS, nextUtcMidnight, utcDay, type UsageSnapshot } from '../lib/limits'
import type { AutoSave, Memory, MemoryKind } from '../lib/memory'
import { optionalSetting } from '../lib/secrets'
import { ResearchRuns } from './research'

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

interface GuestTurnRequest {
  text: string
  /** The guest's earlier turns, from their tab (schema-checked and size-capped by the route). */
  history: { role: 'user' | 'model'; text: string }[]
  userKey?: string
  ip: string
  /** GUEST_SITE_DAILY_CAP. */
  siteCap: number
}

type ChatTurnResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; code: ErrorCode }

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
    return { chat, messages: this.chatMemory.withMarks(id, listMessages(this.db, id)), answering: this.inFlight.has(id) }
  }

  deleteChat(id: string): boolean {
    this.inFlight.get(id)?.abort()
    const deleted = deleteChat(this.db, id)
    this.chatMemory.prune()
    return deleted
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
      this.chatMemory.prune()
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

    const chatId = chat.id
    const memory = this.chatMemory
    const from = { userKey: request.userKey, ip: request.ip }
    const stream = answerStream({
      start: { t: 'start', chat, userMessage, messageId: answer.id, keySource, usage: keySource === 'demo' ? this.usage() : null },
      apiKey,
      keySource,
      model: this.env.GEMINI_MODEL,
      fallbackModel: this.env.GEMINI_FALLBACK_MODEL || undefined,
      history,
      baseUrl: optionalSetting(this.env, 'GEMINI_BASE_URL'),
      controller,
      save: (text, status) => {
        if (status === 'partial') updateMessage(sql, answer.id, text, 'stopped')
        else if (text) updateMessage(sql, answer.id, text, status)
        else sql.exec('DELETE FROM messages WHERE id = ?', answer.id)
      },
      refund,
      finish: () => this.inFlight.delete(chatId),
      // Recall: the memories that match the message, for the model and as chips on the answer.
      prepare: async () => {
        const { system, recalled } = await memory.recall({ ...from, chatId, answerId: answer.id, text: userMessage.content })
        return { system, events: recalled.length ? [{ t: 'recall', messageId: answer.id, memories: recalled }] : [] }
      },
      // Then lasting facts from the person's message (not again on a regenerate: nothing new was said).
      after: request.regenerate
        ? undefined
        : async () => {
            const saves = await this.rememberFromChat(chatId, userMessage.id, from)
            return saves.length ? [{ t: 'memory', messageId: userMessage.id, saves }] : []
          },
    })
    return { ok: true, stream }
  }

  /**
   * A guest's message (an agent named `guest:<id>` from the signed guest
   * cookie, lib/server/agent.ts). Nothing is saved: the conversation lives in
   * the guest's tab and comes with each message, size-capped. Only the
   * guest's daily count is kept here.
   */
  async guestTurn(request: GuestTurnRequest): Promise<ChatTurnResult> {
    const sql = this.db
    const key = chooseKey(request.userKey, optionalSetting(this.env, 'GEMINI_API_KEY'))
    if (!key) return { ok: false, code: 'demo_unavailable' }
    const { apiKey, keySource } = key

    const day = utcDay()
    const network = this.env.DAILY_COUNTER.getByName(`ip:${request.ip}`)
    const site = this.env.DAILY_COUNTER.getByName('site:guest')
    if (keySource === 'demo') {
      if (!tryTake(sql, day, 'guestChat', GUEST_LIMITS.chat)) return { ok: false, code: 'daily_limit_guest' }
      if (!(await network.take('guestChat', GUEST_LIMITS.perIp))) {
        giveBack(sql, day, 'guestChat')
        return { ok: false, code: 'daily_limit_guest_ip' }
      }
      if (!(await site.take('guestChat', request.siteCap))) {
        giveBack(sql, day, 'guestChat')
        await network.giveBack('guestChat')
        return { ok: false, code: 'guest_site_cap' }
      }
    }
    const refund = async () => {
      if (keySource !== 'demo') return
      giveBack(sql, day, 'guestChat')
      await Promise.all([network.giveBack('guestChat'), site.giveBack('guestChat')])
    }

    const now = Date.now()
    const history = historyForModel([
      ...request.history.map((turn, i) => ({ id: String(i), role: turn.role, content: turn.text, status: 'done' as const, createdAt: now })),
      { id: 'next', role: 'user', content: request.text, status: 'done', createdAt: now },
    ])
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: request.text, status: 'done', createdAt: now }
    const usage: UsageSnapshot = {
      chat: { used: used(sql, day, 'guestChat'), limit: GUEST_LIMITS.chat },
      voiceMinutes: { used: 0, limit: 0 },
      research: { used: 0, limit: 0 },
      resetsAt: nextUtcMidnight(),
    }
    const stream = answerStream({
      start: {
        t: 'start',
        chat: { id: 'guest', title: titleFrom(request.history[0]?.text ?? request.text), updatedAt: now },
        userMessage,
        messageId: crypto.randomUUID(),
        keySource,
        usage: keySource === 'demo' ? usage : null,
      },
      apiKey,
      keySource,
      model: this.env.GEMINI_MODEL,
      fallbackModel: this.env.GEMINI_FALLBACK_MODEL || undefined,
      history,
      baseUrl: optionalSetting(this.env, 'GEMINI_BASE_URL'),
      controller: new AbortController(),
      refund,
      finish: () => undefined,
    })
    return { ok: true, stream }
  }

  /* ---------- research runs (agent/research.ts) ---------- */

  private researchRuns?: ResearchRuns

  private get research(): ResearchRuns {
    this.researchRuns ??= new ResearchRuns(this.db, this.env, async (runId) => {
      await this.schedule(0, 'researchTick', { runId })
    })
    return this.researchRuns
  }

  /** Starts a run, behind the per-network daily count too (DAILY_IP_LIMITS.research). */
  async startResearch(question: string, ip: string) {
    const network = this.env.DAILY_COUNTER.getByName(`ip:${ip}`)
    if (!(await network.take('research', DAILY_IP_LIMITS.research))) return { ok: false as const, code: 'research_daily_limit_ip' as const }
    const started = await this.research.start(question)
    if (!started.ok) await network.giveBack('research')
    return started
  }

  listResearch() {
    return this.research.list()
  }

  getResearch(id: string) {
    return this.research.get(id)
  }

  watchResearch(id: string) {
    return this.research.watch(id)
  }

  cancelResearch(id: string) {
    return this.research.cancel(id)
  }

  /** One step of a run; scheduled, never called by a route. */
  async researchTick(payload: { runId: string }): Promise<void> {
    await this.research.tick(payload.runId)
  }

  guestUsage(): UsageSnapshot {
    const day = utcDay()
    return {
      chat: { used: used(this.db, day, 'guestChat'), limit: GUEST_LIMITS.chat },
      voiceMinutes: { used: 0, limit: 0 },
      research: { used: 0, limit: 0 },
      resetsAt: nextUtcMidnight(),
    }
  }

  // ---- Memory (agent/memory.ts): the person's library; in chat through agent/chat-memory.ts. ----

  private chatMemoryInstance?: ChatMemory

  /** Memory in chat: recall, Wren's saves and Undo, "Save to Memory". Holds no key: each call brings its own. */
  private get chatMemory(): ChatMemory {
    this.chatMemoryInstance ??= new ChatMemory(this.db, (userKey, ip) => this.memory(userKey, ip))
    return this.chatMemoryInstance
  }

  /** This person's memory engine, with the request's Gemini key (never stored) and client IP (for the per-network count). */
  private memory(userKey?: string, ip?: string): MemoryEngine {
    const sql = this.db
    // The agent's id names the person's Vectorize namespace and R2 prefix.
    const namespace = this.ctx.id.toString()
    return new MemoryEngine({
      sql,
      vectors:
        optionalSetting(this.env, 'MEMORY_VECTORS') === 'local' ? sqliteStore(sql) : vectorizeStore(this.env.MEMORY_INDEX, namespace),
      files: this.env.MEMORY_FILES,
      filePrefix: namespace,
      ai: memoryAi({
        sql,
        userKey,
        demoKey: optionalSetting(this.env, 'GEMINI_API_KEY'),
        embeddingModel: this.env.GEMINI_EMBEDDING_MODEL,
        model: this.env.GEMINI_MODEL,
        fallbackModel: this.env.GEMINI_FALLBACK_MODEL || undefined,
        baseUrl: optionalSetting(this.env, 'GEMINI_BASE_URL'),
        network: ip ? this.networkCount(ip, 'memoryAiCalls', DAILY_IP_LIMITS.memoryAiCalls) : undefined,
      }),
    })
  }

  private networkCount(ip: string, kind: string, limit: number) {
    const counter = this.env.DAILY_COUNTER.getByName(`ip:${ip}`)
    return { take: () => counter.take(kind, limit), giveBack: () => counter.giveBack(kind) }
  }

  memoryList(request: { query?: string; kind?: MemoryKind; userKey?: string; ip: string }): Promise<MemoryList> {
    return this.memory(request.userKey, request.ip).list(request)
  }

  memoryAddNote(text: string, userKey: string | undefined, ip: string): Promise<MemoryResult<{ memory: Memory }>> {
    return this.memory(userKey, ip).addNote(text)
  }

  memoryAddLink(link: { url: string; title: string }, userKey: string | undefined, ip: string): Promise<MemoryResult<{ memory: Memory }>> {
    return this.memory(userKey, ip).addLink(link.url, link.title)
  }

  memoryAddFile(name: string, bytes: ArrayBuffer, userKey: string | undefined, ip: string): Promise<MemoryResult<{ memory: Memory }>> {
    return this.memory(userKey, ip).addFile(name, bytes)
  }

  memoryUpdate(id: string, patch: { title?: string; text?: string; url?: string }, userKey: string | undefined, ip: string): Promise<MemoryResult<{ memory: Memory }>> {
    return this.memory(userKey, ip).update(id, patch)
  }

  memoryDelete(id: string): Promise<boolean> {
    return this.memory().remove(id)
  }

  memoryFile(id: string): Promise<{ memory: Memory; bytes: ArrayBuffer } | null> {
    return this.memory().file(id)
  }

  /**
   * Saves lasting facts from a chat after an answer, read from the person's
   * own messages in it (never Wren's answers), and keeps them with the message
   * they came from for "Saved to Memory · Undo". The request's key and IP go
   * with every Gemini call it makes.
   */
  private rememberFromChat(chatId: string, messageId: string, from: { userKey?: string; ip: string }): Promise<AutoSave[]> {
    const own = listMessages(this.db, chatId)
      .filter((message) => message.role === 'user')
      .map((message) => ({ id: message.id, text: message.content }))
    return this.chatMemory.remember({ ...from, chatId, messageId, own })
  }

  /** "Save to Memory" on one of the chat's messages (yours or Wren's). */
  async memorySaveMessage(
    chatId: string,
    messageId: string,
    userKey: string | undefined,
    ip: string
  ): Promise<MemoryResult<{ memory: Memory }>> {
    if (!getChat(this.db, chatId)) return { ok: false, code: 'chat_not_found' }
    const message = listMessages(this.db, chatId).find((m) => m.id === messageId)
    if (!message || !message.content.trim()) return { ok: false, code: 'message_not_found' }
    return this.chatMemory.saveMessage({ chatId, message, userKey, ip })
  }

  /** Undo one of Wren's saves in a chat. */
  memoryUndoSave(chatId: string, saveId: string, userKey: string | undefined, ip: string): Promise<MemoryResult<{ save: AutoSave }>> {
    return this.chatMemory.undo({ chatId, saveId, userKey, ip })
  }
}
