import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMemory } from '../../agent/chat-memory'
import { addMessage, createChat, createChatTables, getChat, listMessages, titleFrom, type ChatSummary } from '../../agent/chats'
import { connectLive, type LiveEvents, type LiveTool, type LiveToolResponse } from '../../agent/gemini'
import { MemoryAiError, MemoryEngine, type FileStore, type MemoryAi } from '../../agent/memory'
import { memoryAi } from '../../agent/memory-ai'
import { sqliteStore } from '../../agent/memory-vectors'
import { createMeterTable, used } from '../../agent/meter'
import { VoiceRelay } from '../../agent/voice'
import { MEMORY_TOOLS, VoiceMemory } from '../../agent/voice-memory'
import { VOICE_LIMITS, nextUtcMidnight, utcDay } from '../../lib/limits'
import { MEMORY_LIMITS } from '../../lib/memory'
import type { VoiceServerMessage } from '../../lib/voice'
import { mockEmbedding } from '../mocks/embedding.mjs'
import { memorySql } from '../support/sql'

/**
 * Voice with Memory: a real VoiceRelay and VoiceMemory over a real SQLite
 * agent database (chats, memories, message marks), against a fake Gemini Live
 * upstream and a fake browser. Memory's Gemini calls go to a scripted stand-in
 * (or, for the caps, through the real meter).
 */

const files: FileStore = { put: async () => undefined, get: async () => null, delete: async () => undefined }

interface AiScript {
  facts?: string[]
  used?: string[]
  /** Embedding calls never answer. */
  hang?: boolean
  failWith?: string
}

function scriptedAi(script: AiScript) {
  const calls: { kind: 'embed' | 'json'; prompt: string }[] = []
  const ai: MemoryAi = {
    async embed(text) {
      calls.push({ kind: 'embed', prompt: text })
      if (script.hang) return new Promise<number[]>(() => undefined)
      if (script.failWith) throw new MemoryAiError(script.failWith as never)
      return mockEmbedding(text)
    },
    async json(request) {
      calls.push({ kind: 'json', prompt: request.systemPrompt })
      if (script.failWith) throw new MemoryAiError(script.failWith as never)
      if (request.systemPrompt.startsWith('You check which facts')) return { used: script.used ?? [] }
      return { facts: script.facts ?? [] }
    },
  }
  return { ai, calls }
}

function harness(options: { ai?: AiScript; realMeter?: { aiCallsUsed: number } } = {}) {
  const sql = memorySql()
  createChatTables(sql)
  createMeterTable(sql)
  const scripted = scriptedAi(options.ai ?? {})
  const fetchCalls: string[] = []
  const ai: MemoryAi = options.realMeter
    ? memoryAi({ sql, demoKey: 'demo-key', embeddingModel: 'gemini-embedding-2', model: 'm', baseUrl: 'http://198.18.0.1' })
    : scripted.ai
  if (options.realMeter) {
    vi.stubGlobal('fetch', async (url: string) => {
      fetchCalls.push(String(url))
      throw new Error('no network in tests')
    })
  }
  const engine = () => new MemoryEngine({ sql, vectors: sqliteStore(sql), files, filePrefix: 'a'.repeat(64), ai })
  const engines: { userKey?: string; ip: string }[] = []
  const engineFor = (userKey: string | undefined, ip: string) => {
    engines.push({ userKey, ip })
    return engine()
  }
  const chatMemory = new ChatMemory(sql, engineFor)
  if (options.realMeter) {
    sql.exec('INSERT INTO usage_daily (day, kind, used) VALUES (?, ?, ?)', utcDay(), 'memory', options.realMeter.aiCallsUsed)
  }

  const sent: VoiceServerMessage[] = []
  const client = {
    send: vi.fn((data: string | Uint8Array) => {
      if (typeof data === 'string') sent.push(JSON.parse(data) as VoiceServerMessage)
    }),
    close: vi.fn(),
  }
  const responses: LiveToolResponse[] = []
  const upstream = {
    sendAudio: vi.fn(),
    sendText: vi.fn(),
    sendToolResponse: vi.fn((response: LiveToolResponse) => void responses.push(response)),
    close: vi.fn(),
  }
  let events: LiveEvents | undefined
  let setup: { context: string; tools: LiveTool[] } | undefined
  let chat: ChatSummary | null = null
  const relay = new VoiceRelay({
    client,
    chat: null,
    demoKey: 'demo-key',
    meter: {
      take: async () => 'ok',
      giveBack: async () => undefined,
      secondsLeft: () => 600,
      usage: () => ({ chat: { used: 0, limit: 50 }, voiceMinutes: { used: 0, limit: 10 }, research: { used: 0, limit: 3 }, resetsAt: nextUtcMidnight() }),
    },
    memory: (userKey) =>
      new VoiceMemory(chatMemory, engineFor, { userKey, ip: '198.18.0.9' }, (chatId) =>
        listMessages(sql, chatId)
          .filter((m) => m.role === 'user')
          .map((m) => ({ id: m.id, text: m.content }))
      ),
    connect: async (_key, ev, memory) => {
      events = ev
      setup = memory
      return upstream
    },
    save: (role, text, status) => {
      if (!chat || !getChat(sql, chat.id)) chat = createChat(sql, titleFrom(text))
      const message = addMessage(sql, chat.id, role, text, status)
      return { chat, message }
    },
    finished: () => undefined,
  })
  const library = engine()
  return {
    sql,
    relay,
    sent,
    upstream,
    responses,
    library,
    chatMemory,
    engines,
    calls: scripted.calls,
    fetchCalls,
    start: () => relay.receive(JSON.stringify({ t: 'start' })),
    events: () => events!,
    setup: () => setup!,
    chatId: () => chat!.id,
    messages: () => listMessages(sql, chat!.id),
    marks: () => sent.filter((m): m is Extract<VoiceServerMessage, { t: 'marks' }> => m.t === 'marks'),
    /** Lets pending memory work finish (it awaits no timers, but fake timers hold the relay's tick). */
    settle: () => vi.advanceTimersByTimeAsync(50),
  }
}

/** The person says something, and Wren answers it out loud. */
function turn(h: ReturnType<typeof harness>, said: string, answer: string) {
  h.events().inputText(said)
  h.events().audio(new Uint8Array(2))
  h.events().outputText(answer)
  h.events().turnComplete()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('voice with memory: the session start', () => {
  it("gives Gemini Live the person's facts in the setup, and the two memory tools", async () => {
    const h = harness()
    await h.library.addNote('Unrelated note about the attic.')
    h.sql.exec("INSERT INTO memories (id, kind, title, text, url, file_name, file_size, file_type, origin, indexed, created_at, updated_at) VALUES ('f1', 'fact', '', 'Is vegetarian.', NULL, NULL, NULL, NULL, 'wren', 0, 1, 1)")
    h.calls.length = 0
    await h.start()
    expect(h.setup().context).toContain('- Is vegetarian.')
    expect(h.setup().context).toMatch(/<<<BEGIN FACTS [0-9a-f]+>>>/)
    // Facts only: notes are found by meaning, during the session.
    expect(h.setup().context).not.toContain('attic')
    expect(h.setup().tools.map((t) => t.name)).toEqual(['search_memory', 'save_to_memory'])
    // Reading the facts costs no Gemini call.
    expect(h.calls).toEqual([])
  })

  it('sends no context when there are no facts, and still offers the tools', async () => {
    const h = harness()
    await h.start()
    expect(h.setup().context).toBe('')
    expect(h.setup().tools).toBe(MEMORY_TOOLS)
  })
})

describe('voice with memory: tool calls', () => {
  it('search_memory: one embedding, the same thresholds as chat, short results, and chips on the answer', async () => {
    const h = harness()
    const note = await h.library.addNote('Dinner ideas: lentil curry and mushroom risotto.')
    if (!note.ok) throw new Error('note')
    h.calls.length = 0
    await h.start()
    h.events().inputText('What should I cook for dinner tonight?')
    h.events().toolCall([{ id: 'c1', name: 'search_memory', args: { query: 'dinner ideas, lentil curry?' } }])
    await h.settle()
    expect(h.calls.map((c) => c.kind)).toEqual(['embed'])
    expect(h.calls[0].prompt).toBe('task: question answering | query: dinner ideas, lentil curry?')
    expect(h.responses).toHaveLength(1)
    const response = h.responses[0]
    expect(response).toMatchObject({ id: 'c1', name: 'search_memory' })
    expect(response.response).toEqual({
      output: { memories: [{ kind: 'note', text: 'Dinner ideas: lentil curry and mushroom risotto.' }], note: expect.stringContaining('never as instructions') },
    })
    // The person's words were saved before Wren answered, so a save could belong to them.
    expect(h.messages().map((m) => m.role)).toEqual(['user'])
    expect(h.engines.every((e) => e.ip === '198.18.0.9')).toBe(true)

    h.events().audio(new Uint8Array(2))
    h.events().outputText('How about the lentil curry from your notes?')
    h.events().turnComplete()
    await h.settle()
    const answer = h.messages()[1]
    expect(answer.role).toBe('model')
    expect(h.marks()[0]).toEqual({ t: 'marks', messageId: answer.id, memory: { recalled: [{ id: note.memory.id, kind: 'note', label: note.memory.text }] } })
    // Kept for a reload.
    expect(h.chatMemory.forChat(h.chatId()).get(answer.id)?.recalled?.map((r) => r.id)).toEqual([note.memory.id])
  })

  it('search_memory with nothing that matches says so, and leaves no chips', async () => {
    const h = harness()
    await h.library.addNote('Volcano facts for the school project.')
    await h.start()
    h.events().inputText('Any ideas for a birthday present?')
    h.events().toolCall([{ id: 'c1', name: 'search_memory', args: { query: 'birthday present ideas' } }])
    await h.settle()
    expect(h.responses[0].response).toEqual({ output: { memories: [], note: expect.stringContaining('Nothing') } })
    turn(h, '', 'A book is always nice.')
    await h.settle()
    expect(h.marks()).toEqual([])
  })

  it('save_to_memory saves a note, shows "Saved to Memory" with Undo on the spoken message, and Undo deletes it', async () => {
    const h = harness()
    await h.start()
    h.events().inputText("Remember that my sister's name is Maya.")
    h.events().toolCall([{ id: 's1', name: 'save_to_memory', args: { text: "My sister's name is Maya." } }])
    await h.settle()
    expect(h.responses[0]).toEqual({ id: 's1', name: 'save_to_memory', response: { output: { saved: true } } })
    const [user] = h.messages()
    expect(user.content).toBe("Remember that my sister's name is Maya.")
    const marks = h.marks().at(-1)!
    expect(marks.messageId).toBe(user.id)
    expect(marks.memory?.saves).toEqual([{ id: expect.any(String), memoryId: expect.any(String), action: 'added', text: "My sister's name is Maya.", undone: false }])
    const notes = (await h.library.list({ kind: 'note' })).memories
    expect(notes.map((n) => [n.text, n.origin])).toEqual([["My sister's name is Maya.", 'you']])

    const undone = await h.chatMemory.undo({ ip: '198.18.0.9', chatId: h.chatId(), saveId: marks.memory!.saves![0].id })
    expect(undone).toMatchObject({ ok: true, save: { undone: true } })
    expect((await h.library.list({})).memories).toEqual([])
  })

  it('save_to_memory with words already saved returns that note and adds no Undo line', async () => {
    const h = harness()
    await h.library.addNote("My sister's name is Maya.")
    await h.start()
    h.events().inputText('Remember my sister is Maya.')
    h.events().toolCall([{ id: 's1', name: 'save_to_memory', args: { text: "My sister's name is Maya." } }])
    await h.settle()
    expect(h.responses[0].response).toEqual({ output: { saved: true, note: 'It was already in their Memory.' } })
    expect(h.marks()).toEqual([])
    expect((await h.library.list({})).memories).toHaveLength(1)
  })

  it('a search that takes too long is answered with an error in time, and audio keeps flowing meanwhile', async () => {
    const h = harness({ ai: { hang: true } })
    h.sql.exec("INSERT INTO memories (id, kind, title, text, url, file_name, file_size, file_type, origin, indexed, created_at, updated_at) VALUES ('n1', 'note', '', 'Something to search.', NULL, NULL, NULL, NULL, 'you', 0, 1, 1)")
    await h.start()
    h.events().inputText('What did I save about gardens?')
    h.events().toolCall([{ id: 'c1', name: 'search_memory', args: { query: 'garden notes' } }])
    await h.relay.receive(new Uint8Array(3200).buffer)
    expect(h.upstream.sendAudio).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(VOICE_LIMITS.memoryToolMs - 100)
    expect(h.responses).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(h.responses).toEqual([{ id: 'c1', name: 'search_memory', response: { error: expect.stringContaining('could not be searched') } }])
  })

  it('a save that fails is answered with an error, and the session carries on', async () => {
    const h = harness({ ai: { failWith: 'user_key_invalid' } })
    await h.start()
    h.events().inputText('Remember that I like tea.')
    h.events().toolCall([{ id: 's1', name: 'save_to_memory', args: { text: 'Likes tea.' } }])
    await h.settle()
    expect(h.responses[0].response).toEqual({ error: expect.stringContaining('could not save') })
    turn(h, '', 'Sorry, I couldn’t save that just now.')
    await h.settle()
    expect(h.messages().map((m) => m.role)).toEqual(['user', 'model'])
    expect(h.sent.some((m) => m.t === 'end' || m.t === 'error')).toBe(false)
  })

  it('a cancelled call gets no answer; unknown tools and bad arguments get an error', async () => {
    const h = harness({ ai: { hang: true } })
    h.sql.exec("INSERT INTO memories (id, kind, title, text, url, file_name, file_size, file_type, origin, indexed, created_at, updated_at) VALUES ('n1', 'note', '', 'Something to search.', NULL, NULL, NULL, NULL, 'you', 0, 1, 1)")
    await h.start()
    h.events().inputText('Find my notes about the attic.')
    h.events().toolCall([{ id: 'c1', name: 'search_memory', args: { query: 'attic notes' } }])
    h.events().toolCancelled(['c1'])
    await vi.advanceTimersByTimeAsync(VOICE_LIMITS.memoryToolMs + 100)
    expect(h.responses).toEqual([])
    h.events().toolCall([
      { id: 'c2', name: 'delete_everything', args: {} },
      { id: 'c3', name: 'save_to_memory', args: { text: 42 } },
    ])
    await h.settle()
    expect(h.responses.map((r) => [r.id, 'error' in r.response])).toEqual([
      ['c2', true],
      ['c3', true],
    ])
  })

  it(`answers at most ${VOICE_LIMITS.memoryToolsPerTurn} memory calls in one turn, then resets for the next`, async () => {
    const h = harness()
    await h.library.addNote('Garden plan for spring.')
    h.calls.length = 0
    await h.start()
    h.events().inputText('Tell me about my garden plans.')
    const calls = Array.from({ length: VOICE_LIMITS.memoryToolsPerTurn + 1 }, (_, i) => ({ id: `c${i}`, name: 'search_memory', args: { query: 'garden plan' } }))
    h.events().toolCall(calls)
    await h.settle()
    expect(h.calls.filter((c) => c.kind === 'embed')).toHaveLength(VOICE_LIMITS.memoryToolsPerTurn)
    expect(h.responses.filter((r) => 'error' in r.response).map((r) => r.id)).toEqual([`c${VOICE_LIMITS.memoryToolsPerTurn}`])
    turn(h, '', 'You planned a spring garden.')
    await h.settle()
    h.responses.length = 0
    h.events().toolCall([{ id: 'next', name: 'search_memory', args: { query: 'garden plan' } }])
    await h.settle()
    expect('output' in h.responses[0].response).toBe(true)
  })
})

describe('voice with memory: after each answer', () => {
  it('Wren saves lasting facts from what was said, with "Saved to Memory" marks, and checks which facts the answer used', async () => {
    const h = harness({ ai: { facts: ['Is vegetarian.'], used: ['f1'] } })
    h.sql.exec("INSERT INTO memories (id, kind, title, text, url, file_name, file_size, file_type, origin, indexed, created_at, updated_at) VALUES ('f1', 'fact', '', 'Lives in Portland.', NULL, NULL, NULL, NULL, 'wren', 0, 1, 1)")
    await h.start()
    turn(h, "I'm vegetarian. Any dinner idea near home?", 'Try a mushroom stew; Portland has great mushrooms.')
    await h.settle()
    const [user, answer] = h.messages()
    const byMessage = new Map(h.marks().map((m) => [m.messageId, m.memory]))
    expect(byMessage.get(answer.id)?.recalled).toEqual([{ id: 'f1', kind: 'fact', label: 'Lives in Portland.' }])
    expect(byMessage.get(user.id)?.saves).toEqual([expect.objectContaining({ action: 'added', text: 'Is vegetarian.', undone: false })])
    // Both kept for a reload.
    const kept = h.chatMemory.forChat(h.chatId())
    expect(kept.get(user.id)?.saves).toHaveLength(1)
    expect(kept.get(answer.id)?.recalled).toHaveLength(1)
    // The extractor read only the person's own words; attribution and extraction each made one JSON call.
    expect(h.calls.filter((c) => c.kind === 'json')).toHaveLength(2)
  })

  it('reads each of your messages once, and does nothing after an interrupted answer', async () => {
    const h = harness({ ai: { facts: ['Has a dog named Juniper.'] } })
    await h.start()
    h.events().inputText('My dog is called Juniper.')
    h.events().audio(new Uint8Array(2))
    h.events().outputText('What a lovely')
    h.events().interrupted()
    await h.settle()
    expect(h.calls).toEqual([])
    expect(h.marks()).toEqual([])

    turn(h, 'Tell me more.', 'Juniper is a lovely name for a dog.')
    await h.settle()
    const jsonCalls = h.calls.filter((c) => c.kind === 'json').length
    expect(jsonCalls).toBe(1)
    expect(h.marks().map((m) => m.memory?.saves?.[0]?.text)).toEqual(['Has a dog named Juniper.'])
  })

  it('when the daily memory allowance is used up, voice carries on without memory, quietly', async () => {
    const h = harness({ realMeter: { aiCallsUsed: MEMORY_LIMITS.dailyAiCalls } })
    h.sql.exec("INSERT INTO memories (id, kind, title, text, url, file_name, file_size, file_type, origin, indexed, created_at, updated_at) VALUES ('n1', 'note', '', 'Dinner: lentil curry.', NULL, NULL, NULL, NULL, 'you', 0, 1, 1)")
    await h.start()
    h.events().inputText("What's a good dinner tonight?")
    h.events().toolCall([{ id: 'c1', name: 'search_memory', args: { query: 'dinner tonight' } }])
    await h.settle()
    expect(h.responses[0].response).toEqual({ output: { memories: [], note: expect.stringContaining('Nothing') } })
    h.events().audio(new Uint8Array(2))
    h.events().outputText('How about a stir fry?')
    h.events().turnComplete()
    await h.settle()
    expect(h.messages().map((m) => m.role)).toEqual(['user', 'model'])
    expect(h.sent.some((m) => m.t === 'error' || m.t === 'end')).toBe(false)
    expect(h.marks()).toEqual([])
    // Nothing reached Gemini, and nothing was taken past the allowance.
    expect(h.fetchCalls).toEqual([])
    expect(used(h.sql, utcDay(), 'memory')).toBe(MEMORY_LIMITS.dailyAiCalls)
  })
})

/** A stand-in for Gemini Live's socket as the Workers runtime hands it over. */
class FakeLiveSocket {
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  accept() {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close() {}
  emit(message: unknown) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(message) })
  }
}

describe('connectLive with tools', () => {
  it('declares the tools in the setup, reports tool calls and cancellations, and sends tool responses', async () => {
    vi.useRealTimers()
    const socket = new FakeLiveSocket()
    vi.stubGlobal('fetch', async () => ({ webSocket: socket }))
    const events = { audio: vi.fn(), inputText: vi.fn(), outputText: vi.fn(), interrupted: vi.fn(), turnComplete: vi.fn(), goAway: vi.fn(), closed: vi.fn(), toolCall: vi.fn(), toolCancelled: vi.fn() }
    const opening = connectLive(
      { apiKey: 'k', keySource: 'demo', model: 'gemini-3.8-live', systemPrompt: 'You are Wren.\n\nFACTS', history: [], tools: MEMORY_TOOLS, setupMs: 1000 },
      events
    )
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const setup = socket.sent[0].setup as Record<string, unknown>
    expect(setup.systemInstruction).toEqual({ parts: [{ text: 'You are Wren.\n\nFACTS' }] })
    expect(setup.tools).toEqual([{ functionDeclarations: MEMORY_TOOLS }])
    socket.emit({ setupComplete: {} })
    const session = await opening

    socket.emit({ toolCall: { functionCalls: [{ id: 'fc1', name: 'search_memory', args: { query: 'dinner' } }, { name: 'no id' }] } })
    socket.emit({ toolCallCancellation: { ids: ['fc1'] } })
    await vi.waitFor(() => expect(events.toolCancelled).toHaveBeenCalled())
    expect(events.toolCall).toHaveBeenCalledWith([{ id: 'fc1', name: 'search_memory', args: { query: 'dinner' } }])
    expect(events.toolCancelled).toHaveBeenCalledWith(['fc1'])

    session.sendToolResponse({ id: 'fc1', name: 'search_memory', response: { output: { memories: [] } } })
    expect(socket.sent.at(-1)).toEqual({ toolResponse: { functionResponses: [{ id: 'fc1', name: 'search_memory', response: { output: { memories: [] } } }] } })
  })

  it('leaves tools out of the setup when there are none', async () => {
    vi.useRealTimers()
    const socket = new FakeLiveSocket()
    vi.stubGlobal('fetch', async () => ({ webSocket: socket }))
    const events = { audio: vi.fn(), inputText: vi.fn(), outputText: vi.fn(), interrupted: vi.fn(), turnComplete: vi.fn(), goAway: vi.fn(), closed: vi.fn(), toolCall: vi.fn(), toolCancelled: vi.fn() }
    void connectLive({ apiKey: 'k', keySource: 'demo', model: 'm', systemPrompt: 'p', history: [], setupMs: 50 }, events).catch(() => undefined)
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect((socket.sent[0].setup as Record<string, unknown>).tools).toBeUndefined()
  })
})
