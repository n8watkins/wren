'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatSummary } from '@/agent/chats'
import { ApiError, api, sendGuestMessage, sendMessage, startGuestSession } from '@/lib/client/api'
import { runsApi } from '@/lib/client/runs-api'
import { authClient } from '@/lib/client/auth-client'
import { GUEST_CHAT_KEY, KEYS, useLocalSetting, useSessionSetting, writeLocal, writeSession } from '@/lib/client/storage'
import { turnstileToken } from '@/lib/client/turnstile'
import { SIGN_IN_FIXES, errorMessage, isErrorCode } from '@/lib/errors'
import { DAILY_LIMITS, GUEST_LIMITS, RESEARCH_LIMITS, nextUtcMidnight, type UsageSnapshot } from '@/lib/limits'
import type { RecalledMemory } from '@/lib/memory'
import type { RunDetail } from '@/lib/research'
import type { ExplainerId } from '../explainers'
import { Icon } from '../Icons'
import { WrenMark } from '../WrenMark'
import { BottomNav, MobileHeader, Sidebar, type Person, type Place, type Theme } from './Chrome'
import { Composer } from './Composer'
import { MemoryPage, type MemoryAdding } from './MemoryPage'
import { ConfirmDeleteDialog, ExplainerDialog, HowItWorksDialog, KeyDialog, SignInDialog } from './Dialogs'
import { settledMessage, type ResearchMessage } from './ResearchCard'
import { Runs } from './Runs'
import { Thread, type StreamingAnswer } from './Thread'
import { Tips } from './Tips'
import { useVoice } from './useVoice'
import { DemoNotice } from './DemoNotice'
import type { Region } from '@/lib/region'

export interface WrenAppProps {
  person: Person | null
  github: boolean
  initialChats: ChatSummary[]
  initialUsage: UsageSnapshot | null
  /** Turnstile's public site key when guest chat is on; null means guests must sign in. */
  guestSiteKey: string | null
  /** Whether this browser already has a valid guest session (the signed guest cookie). */
  guestReady: boolean
  /** From Cloudflare's country, on the server: visitors from the EEA, Switzerland and the UK get a firmer own-key nudge. */
  region: Region
}

/** Wren's last automatic save of a voice session takes a few seconds after it ends (one or two Gemini calls). */
const VOICE_MARKS_REFRESH_MS = 6_000

const EMPTY_USAGE = (guest: boolean): UsageSnapshot => ({
  chat: { used: 0, limit: guest ? GUEST_LIMITS.chat : DAILY_LIMITS.chat },
  voiceMinutes: { used: 0, limit: guest ? 0 : DAILY_LIMITS.voiceMinutes },
  research: { used: 0, limit: guest ? 0 : DAILY_LIMITS.research },
  resetsAt: nextUtcMidnight(),
})

/** A guest's chat, kept only in this tab. */
interface GuestChat {
  title: string
  messages: ChatMessage[]
}

function parseGuestChat(raw: string | null): GuestChat | null {
  try {
    const saved = JSON.parse(raw ?? 'null') as GuestChat | null
    if (!saved || typeof saved.title !== 'string' || !Array.isArray(saved.messages)) return null
    return {
      title: saved.title,
      messages: saved.messages.filter(
        (m) => m && (m.role === 'user' || m.role === 'model') && typeof m.content === 'string' && typeof m.id === 'string'
      ),
    }
  } catch {
    return null
  }
}

/** A new message's id and time (outside render: called from event handlers). */
function stamp(): { id: string; at: number } {
  return { id: `g-${crypto.randomUUID()}`, at: Date.now() }
}

function guestTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`
}

const SUGGESTIONS: { icon: 'chat' | 'res' | 'mem'; tone: string; text: string }[] = [
  { icon: 'chat', tone: 'var(--ember)', text: 'Talk me through a weeknight risotto' },
  { icon: 'res', tone: 'var(--saffron)', text: 'What should I look for in an e-bike under $1,500?' },
  { icon: 'mem', tone: 'var(--sage)', text: 'Plan a week of vegetarian dinners' },
]

function placeFrom(pathname: string): { place: Place; chatId: string | null } {
  if (pathname.startsWith('/runs')) return { place: 'runs', chatId: null }
  if (pathname.startsWith('/memory')) return { place: 'memory', chatId: null }
  const match = /^\/chat\/([0-9a-f-]{36})$/.exec(pathname)
  return { place: 'chat', chatId: match ? match[1] : null }
}

function applyTheme(theme: Theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

/** The tips tour's saved state: whether it is running, and which step it is on. */
function parseTips(raw: string | null): { active: boolean; step: number } {
  try {
    const saved = JSON.parse(raw ?? 'null') as { active?: unknown; step?: unknown } | null
    const step = typeof saved?.step === 'number' && Number.isInteger(saved.step) && saved.step >= 0 ? saved.step : 0
    return { active: saved?.active === true, step }
  } catch {
    return { active: false, step: 0 }
  }
}

type Modal =
  | { kind: 'how' }
  | { kind: 'sign-in'; reason: string | null }
  | { kind: 'key' }
  | { kind: 'explain'; id: ExplainerId }
  | { kind: 'delete'; chat: ChatSummary }
  | null

/** The whole app: one client shell that the routes (/, /chat/:id, /runs, /memory) share. */
export function WrenApp({ person, github, initialChats, initialUsage, guestSiteKey, guestReady, region }: WrenAppProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { place, chatId } = placeFrom(pathname)

  const [chats, setChats] = useState(initialChats)
  const isGuest = person === null
  const guestOn = isGuest && guestSiteKey !== null
  const [usage, setUsage] = useState<UsageSnapshot>(() => initialUsage ?? EMPTY_USAGE(isGuest))
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadedChatId, setLoadedChatId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState<StreamingAnswer | null>(null)
  const [error, setErrorState] = useState<{ message: string; signIn: boolean; info?: boolean } | null>(null)
  const setError = useCallback((message: string | null, signIn = false, info = false) => {
    setErrorState(message === null ? null : { message, signIn, info })
  }, [])
  const failWith = (failure: unknown) => {
    const code = failure instanceof ApiError ? failure.code : 'internal'
    setError(failure instanceof ApiError ? failure.message : errorMessage('internal'), isErrorCode(code) && SIGN_IN_FIXES.has(code))
  }
  const turnstileBox = useRef<HTMLDivElement>(null)
  /**
   * The guest session (Turnstile, then /api/guest/start for the signed guest
   * cookie), started in the background on page load so the human check never
   * interrupts someone who has typed. Most visitors never see it; when
   * Cloudflare is unsure, its small challenge shows above the composer
   * (turnstileBox). One start at a time: a send waits for the one in flight.
   */
  const guestStart = useRef<Promise<void> | null>(null)
  const startGuest = useCallback((): Promise<void> => {
    if (!guestSiteKey) return Promise.reject(new ApiError('guest_unavailable', errorMessage('guest_unavailable')))
    guestStart.current ??= (async () => {
      let token: string
      try {
        token = await turnstileToken(turnstileBox.current ?? document.body, guestSiteKey)
      } catch {
        throw new ApiError('turnstile_failed', errorMessage('turnstile_failed'))
      }
      await startGuestSession(token)
    })().finally(() => {
      guestStart.current = null
    })
    return guestStart.current
  }, [guestSiteKey])
  useEffect(() => {
    // A failure here is quiet: sending tries again and says what went wrong.
    if (guestOn && !guestReady) startGuest().catch(() => undefined)
  }, [guestOn, guestReady, startGuest])
  const guestChat = parseGuestChat(useSessionSetting(GUEST_CHAT_KEY))
  const saveGuestChat = (next: GuestChat | null) => writeSession(GUEST_CHAT_KEY, next ? JSON.stringify(next) : null)
  const [draft, setDraft] = useState('')
  const [focusKey, setFocusKey] = useState(0)
  // Research mode in the composer: what you send starts a research run in this chat.
  const [researchOn, setResearchOn] = useState(false)
  const [researchStarting, setResearchStarting] = useState(false)
  // The Memory page's open add form; the sidebar's Memory "+" opens the note form from anywhere.
  const [memoryAdding, setMemoryAdding] = useState<MemoryAdding>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [menu, setMenu] = useState<{ open: boolean; at: string }>({ open: false, at: pathname })
  // The title menu closes whenever the address changes or a dialog opens.
  if (menu.open && (menu.at !== pathname || modal !== null)) setMenu({ open: false, at: pathname })
  const menuOpen = menu.open && menu.at === pathname
  // Leaving the Memory page closes its add form.
  const [lastPlace, setLastPlace] = useState(place)
  if (lastPlace !== place) {
    setLastPlace(place)
    if (place !== 'memory') setMemoryAdding(null)
  }
  const setMenuOpen = (open: boolean) => setMenu({ open, at: pathname })

  const userKey = useLocalSetting(KEYS.geminiKey)
  const savedTheme = useLocalSetting(KEYS.theme)
  const theme: Theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'auto'
  // The server assumes the explainer was seen, so it only opens after hydration.
  const firstVisit = useLocalSetting(KEYS.seenHow, '1') === null
  const tips = parseTips(useLocalSetting(KEYS.tips))
  // The free-demo notice stays until dismissed or until a key of your own is on.
  // Like the explainer it appears after hydration, so a returning visitor who
  // dismissed it never sees it flash.
  const demoNoticeOn = useLocalSetting(KEYS.demoNotice, '1') === null && userKey === null
  const abortRef = useRef<AbortController | null>(null)
  const streamChatRef = useRef<string | null>(null)
  // A chat this tab just created, until its address (/chat/<id>) is committed:
  // a fast answer can end before Next applies the address change.
  const newChatRef = useRef<string | null>(null)
  const currentChatRef = useRef<string | null>(chatId)
  useEffect(() => {
    currentChatRef.current = chatId
  }, [chatId])

  const setTheme = (next: Theme) => {
    applyTheme(next)
    writeLocal(KEYS.theme, next === 'auto' ? null : next)
  }

  const saveTips = (next: { active: boolean; step: number }) => {
    writeLocal(KEYS.tips, JSON.stringify(next))
  }

  // Load the chat in the address bar (unless it is the one being written into).
  useEffect(() => {
    if (!person || place !== 'chat') return
    if (chatId === null) {
      if (streamChatRef.current === null && newChatRef.current === null) {
        setMessages([])
        setLoadedChatId(null)
      }
      return
    }
    if (newChatRef.current === chatId) newChatRef.current = null
    if (chatId === loadedChatId || chatId === streamChatRef.current) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getChat(chatId)
      .then((data) => {
        if (cancelled) return
        setMessages(data.messages)
        setLoadedChatId(chatId)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setMessages([])
        setLoadedChatId(chatId)
        setError(failure instanceof ApiError ? failure.message : errorMessage('internal'))
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [person, place, chatId, loadedChatId, setError])

  const refreshUsage = useCallback(() => {
    if (person) api.usage().then(setUsage, () => undefined)
    else api.guestUsage().then(setUsage, () => undefined)
  }, [person])

  const openChat = (id: string) => {
    newChatRef.current = null
    setError(null)
    router.push(`/chat/${id}`)
  }

  const newChat = () => {
    newChatRef.current = null
    setError(null)
    setDraft('')
    setResearchOn(false)
    if (!streaming) {
      streamChatRef.current = null
      setMessages([])
      setLoadedChatId(null)
      if (isGuest) saveGuestChat(null)
    }
    router.push('/')
    setFocusKey((n) => n + 1)
  }

  /**
   * A guest's message: their chat lives in this tab, the earlier turns go with
   * each message, and the first one runs the human check (Turnstile).
   */
  const runGuest = async (opts: { text?: string; regenerate?: boolean }) => {
    if (!guestSiteKey) return
    const start = guestChat ?? { title: '', messages: [] }
    const base = opts.regenerate && start.messages.at(-1)?.role === 'model' ? start.messages.slice(0, -1) : start.messages
    const prompt = opts.regenerate ? base.at(-1) : undefined
    const text = opts.regenerate ? prompt?.content : opts.text
    if (!text || (opts.regenerate && prompt?.role !== 'user')) return
    const earlier = opts.regenerate ? base.slice(0, -1) : base
    const sent = stamp()
    const withPrompt: GuestChat = {
      title: start.title || guestTitle(text),
      messages: opts.regenerate ? base : [...base, { id: sent.id, role: 'user', content: text, status: 'done', createdAt: sent.at }],
    }
    saveGuestChat(withPrompt)

    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setStreaming({ chatId: null, text: '' })
    let answer = ''
    let finished: ChatMessage['status'] | null = null
    try {
      // The background check may still be running: wait for it rather than be turned away.
      await guestStart.current?.catch(() => undefined)
      for await (const event of sendGuestMessage({
        text,
        history: earlier.map((m) => ({ role: m.role, text: m.content })).slice(-GUEST_LIMITS.historyTurns),
        userKey,
        signal: controller.signal,
        startGuest,
      })) {
        if (event.t === 'start' && event.usage) setUsage(event.usage)
        else if (event.t === 'delta') {
          answer += event.text
          setStreaming((current) => (current ? { ...current, text: answer } : current))
        } else if (event.t === 'restart') {
          answer = ''
          setStreaming((current) => (current ? { ...current, text: '', restarted: true } : current))
        } else if (event.t === 'done') finished = event.status
        else if (event.t === 'error') {
          finished = 'error'
          setError(errorMessage(event.code), SIGN_IN_FIXES.has(event.code))
        }
      }
      if (controller.signal.aborted && finished === null) finished = 'stopped'
    } catch (failure) {
      if (!opts.regenerate) {
        saveGuestChat(start.messages.length ? start : null)
        setDraft(text)
      }
      failWith(failure)
    } finally {
      if (answer) {
        const done = stamp()
        saveGuestChat({
          ...withPrompt,
          messages: [...withPrompt.messages, { id: done.id, role: 'model', content: answer, status: finished ?? 'stopped', createdAt: done.at }],
        })
      }
      setStreaming(null)
      abortRef.current = null
      refreshUsage()
    }
  }

  const run = async (opts: { text?: string; regenerate?: boolean }) => {
    if (!person) {
      if (guestOn) return runGuest(opts)
      setModal({ kind: 'sign-in', reason: 'Sign in to start chatting. It keeps your chats on every device.' })
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    const targetChat = place === 'chat' ? chatId : null
    streamChatRef.current = targetChat
    setError(null)
    if (opts.text) {
      setMessages((list) => [
        ...list,
        { id: `pending-${Date.now()}`, role: 'user', content: opts.text ?? '', status: 'done', createdAt: Date.now() },
      ])
    }
    setStreaming({ chatId: targetChat, text: '' })
    let text = ''
    let answerId = ''
    let recalled: RecalledMemory[] = []
    let finished: ChatMessage['status'] | null = null
    let settled = false
    // The answer is over at done (or an error, or the stream ending): show it
    // and free the composer. The stream may stay open a moment longer for
    // Wren's saves, which land on the person's message.
    const settle = () => {
      if (settled) return
      settled = true
      // Show the answer unless the person moved to another chat meanwhile. A
      // new chat's address may not have been committed yet, so the chat this
      // started in (none, for a new chat) counts as here too.
      const answeredChat = streamChatRef.current
      const stillHere = currentChatRef.current === answeredChat || currentChatRef.current === targetChat
      if (text && answerId && stillHere) {
        const status = finished ?? 'stopped'
        const memory = recalled.length ? { recalled } : undefined
        setMessages((list) => [...list, { id: answerId, role: 'model', content: text, status, createdAt: Date.now(), memory }])
      }
      setStreaming(null)
      streamChatRef.current = null
      abortRef.current = null
      refreshUsage()
    }
    try {
      for await (const event of sendMessage({
        chatId: targetChat ?? undefined,
        text: opts.text,
        regenerate: opts.regenerate,
        userKey,
        signal: controller.signal,
      })) {
        if (event.t === 'start') {
          answerId = event.messageId
          streamChatRef.current = event.chat.id
          setLoadedChatId(event.chat.id)
          setStreaming((s) => (s ? { ...s, chatId: event.chat.id } : s))
          setMessages((list) => list.map((m) => (m.id.startsWith('pending-') ? event.userMessage : m)))
          setChats((list) => [{ ...event.chat, updatedAt: Date.now() }, ...list.filter((c) => c.id !== event.chat.id)])
          if (event.usage) setUsage(event.usage)
          if (targetChat === null) {
            newChatRef.current = event.chat.id
            window.history.replaceState(null, '', `/chat/${event.chat.id}`)
          }
        } else if (event.t === 'recall') {
          // Before the answer: what search found. After it: those plus the facts it used.
          recalled = event.memories
          const { messageId, memories } = event
          setStreaming((s) => (s ? { ...s, recalled } : s))
          setMessages((list) => list.map((m) => (m.id === messageId ? { ...m, memory: { ...m.memory, recalled: memories } } : m)))
        } else if (event.t === 'delta') {
          text += event.text
          setStreaming((s) => (s ? { ...s, text } : s))
        } else if (event.t === 'restart') {
          text = ''
          setStreaming((s) => (s ? { ...s, text: '', restarted: true } : s))
        } else if (event.t === 'done') {
          finished = event.status
          settle()
        } else if (event.t === 'memory') {
          const { messageId, saves } = event
          setMessages((list) =>
            list.map((m) => (m.id === messageId ? { ...m, memory: { ...m.memory, saves: [...(m.memory?.saves ?? []), ...saves] } } : m))
          )
        } else if (event.t === 'error') {
          finished = 'error'
          setError(errorMessage(event.code))
        }
      }
      if (controller.signal.aborted && finished === null) finished = 'stopped'
    } catch (failure) {
      setMessages((list) => list.filter((m) => !m.id.startsWith('pending-')))
      if (opts.text) setDraft(opts.text)
      failWith(failure)
      if (failure instanceof ApiError && failure.code === 'unauthorized') {
        setModal({ kind: 'sign-in', reason: 'Your session ended. Sign in again to keep chatting.' })
      }
    } finally {
      settle()
    }
  }

  /*
   * Voice (components/app/useVoice.ts): spoken turns land in this chat as
   * they are saved, a new chat gets its address like a typed one, and moving
   * to another chat or page ends the session.
   */
  const voiceChatRef = useRef<string | null>(null)
  /** Wren's last automatic save of a voice session runs in the agent after the socket closes; its marks come with the chat. */
  const refreshMarksLater = (id: string) => {
    window.setTimeout(() => {
      api
        .getChat(id)
        .then((data) => {
          const marks = new Map(data.messages.map((m) => [m.id, m.memory]))
          setMessages((list) => list.map((m) => (marks.has(m.id) ? { ...m, memory: marks.get(m.id) } : m)))
        })
        .catch(() => undefined)
    }, VOICE_MARKS_REFRESH_MS)
  }
  const voice = useVoice({
    onMessage: (chat, message) => {
      setChats((list) => [{ ...chat, updatedAt: Date.now() }, ...list.filter((c) => c.id !== chat.id)])
      if (voiceChatRef.current !== chat.id) {
        voiceChatRef.current = chat.id
        newChatRef.current = chat.id
        setLoadedChatId(chat.id)
        window.history.replaceState(null, '', `/chat/${chat.id}`)
      }
      setMessages((list) => (list.some((m) => m.id === message.id) ? list : [...list, message]))
    },
    // Memory's chips and "Saved to Memory" lines on spoken turns, as they're known.
    onMarks: (messageId, memory) => setMessages((list) => list.map((m) => (m.id === messageId ? { ...m, memory: memory ?? undefined } : m))),
    onUsage: setUsage,
    onEnded: (problem) => {
      const ended = voiceChatRef.current
      voiceChatRef.current = null
      if (ended) refreshMarksLater(ended)
      if (problem) setError(problem.message, problem.signIn, problem.info)
      refreshUsage()
    },
  })
  const voiceOn = voice.view !== null
  const stopVoice = voice.stop
  useEffect(() => {
    if (voiceOn && (place !== 'chat' || chatId !== voiceChatRef.current)) stopVoice()
  }, [voiceOn, place, chatId, stopVoice])

  const toggleVoice = () => {
    if (voice.view) return voice.stop()
    if (!person) {
      setModal({ kind: 'sign-in', reason: errorMessage('voice_sign_in') })
      return
    }
    setError(null)
    voiceChatRef.current = chatId
    voice.start({ chatId, userKey })
  }

  const send = () => {
    const text = draft.trim()
    if (!text) return
    // While talking, a typed message goes to the voice session and Wren answers out loud.
    if (voice.view && voice.sendText(text)) {
      setDraft('')
      return
    }
    if (streaming) return
    if (researchOn) {
      void startResearch(text)
      return
    }
    setDraft('')
    void run({ text })
  }

  const researchSignIn = () =>
    setModal({ kind: 'sign-in', reason: `Sign in to research: ${DAILY_LIMITS.research} runs a day, with each report in your chat.` })

  /**
   * Research from chat: starts a run in this chat (or a new one) and adds
   * your question and Wren's card for the run, which watches it and turns
   * into the report (components/app/ResearchCard.tsx).
   */
  const startResearch = async (question: string) => {
    if (!person) return researchSignIn()
    if (streaming || researchStarting) return
    setResearchStarting(true)
    setError(null)
    const targetChat = place === 'chat' ? chatId : null
    try {
      const started = await runsApi.startInChat(question, targetChat)
      setDraft((current) => (current.trim() === question ? '' : current))
      setResearchOn(false)
      setUsage(started.usage)
      setChats((list) => [{ ...started.chat, updatedAt: Date.now() }, ...list.filter((c) => c.id !== started.chat.id)])
      const added = [started.userMessage, started.message]
      if (started.chat.id !== targetChat) {
        // A new chat (or the old one was deleted meanwhile): this tab made it, so it needn't be loaded.
        newChatRef.current = started.chat.id
        setLoadedChatId(started.chat.id)
        setMessages(added)
        window.history.replaceState(null, '', `/chat/${started.chat.id}`)
      } else {
        setMessages((list) => [...list, ...added])
      }
    } catch (failure) {
      failWith(failure)
      if (failure instanceof ApiError && failure.code === 'unauthorized') {
        setModal({ kind: 'sign-in', reason: 'Your session ended. Sign in again to research.' })
      }
    } finally {
      setResearchStarting(false)
    }
  }

  const toggleResearch = () => {
    if (!person) return researchSignIn()
    setError(null)
    setResearchOn((on) => !on)
    setFocusKey((n) => n + 1)
  }

  /** "Research this" on an answer: the question it answered, in the composer, ready to research. */
  const researchThis = (messageId: string) => {
    if (!person) return researchSignIn()
    const index = shownMessages.findIndex((m) => m.id === messageId)
    const asked = shownMessages
      .slice(0, Math.max(0, index))
      .reverse()
      .find((m) => m.role === 'user')
    setError(null)
    setDraft((asked?.content ?? '').trim().slice(0, RESEARCH_LIMITS.questionChars))
    setResearchOn(true)
    setFocusKey((n) => n + 1)
  }

  /** A run started from chat has ended: its report (or how it ended) replaces the card. */
  const researchSettled = (messageId: string, ended: RunDetail) => {
    setMessages((list) => list.map((m) => (m.id === messageId && m.research ? settledMessage(m as ResearchMessage, ended) : m)))
    // A failed run gives the day's run back.
    if (ended.status === 'failed' || (ended.status === 'done' && !ended.report)) refreshUsage()
  }

  const stop = () => {
    const id = streamChatRef.current
    abortRef.current?.abort()
    if (id) void api.stop(id).catch(() => undefined)
  }

  const regenerate = () => {
    if (streaming) return
    if (isGuest) {
      void runGuest({ regenerate: true })
      return
    }
    if (!chatId) return
    setMessages((list) => (list.at(-1)?.role === 'model' ? list.slice(0, -1) : list))
    void run({ regenerate: true })
  }

  const deleteChat = async (chat: ChatSummary) => {
    setModal(null)
    try {
      await api.deleteChat(chat.id)
      setChats((list) => list.filter((c) => c.id !== chat.id))
      if (chat.id === chatId) newChat()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : errorMessage('internal'))
    }
  }

  const signOut = async () => {
    await authClient.signOut()
    // A full load, so the server renders the signed-out shell.
    window.location.replace(new URL('/', window.location.href))
  }

  const saveKey = (key: string | null) => {
    writeLocal(KEYS.geminiKey, key)
    setError(null)
  }

  const closeHow = () => {
    writeLocal(KEYS.seenHow, '1')
    // Closing it to open another dialog (its own-key link) leaves that one open.
    setModal((current) => (current?.kind === 'key' ? current : null))
  }

  const explain = (id: ExplainerId) => setModal({ kind: 'explain', id })

  const currentTitle =
    place === 'runs'
      ? 'Research runs'
      : place === 'memory'
        ? 'Memory'
        : isGuest
          ? guestChat?.title || 'New chat'
          : chatId
            ? (chats.find((c) => c.id === chatId)?.title ?? 'Chat')
            : 'New chat'

  const shownMessages = place !== 'chat' ? [] : isGuest ? (guestChat?.messages ?? []) : chatId === loadedChatId ? messages : []
  const showWelcome = place === 'chat' && !chatId && shownMessages.length === 0 && !streaming
  const chromeProps = {
    place,
    chats,
    currentChatId: chatId,
    person,
    usage,
    ownKey: userKey !== null,
    guest: guestOn,
    theme,
    setTheme,
    onNewChat: newChat,
    onOpenChat: openChat,
    onDeleteChat: (chat: ChatSummary) => setModal({ kind: 'delete', chat }),
    onSignIn: () => setModal({ kind: 'sign-in', reason: null }),
    onSignOut: signOut,
    onKey: () => setModal({ kind: 'key' }),
    onMemoryAdd: () => {
      setMemoryAdding('note')
      if (place !== 'memory') router.push('/memory')
    },
  }

  return (
    <div className="app">
      <Sidebar {...chromeProps} />
      <main className="main">
        <MobileHeader
          {...chromeProps}
          title={currentTitle}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          onHelp={() => setModal({ kind: 'how' })}
          onMeter={() => explain('meter')}
        />
        <div className="mh">
          <h1 data-testid="title">{currentTitle}</h1>
          <span className="sp" />
          <button type="button" className={userKey ? 'pill on' : 'pill'} onClick={() => setModal({ kind: 'key' })} data-testid="key-pill">
            <Icon name="key" />
            {userKey ? 'Your key is on' : 'Use your own key'}
          </button>
          <button type="button" className="ib help" aria-label="How Wren works" title="How it works" onClick={() => setModal({ kind: 'how' })} data-testid="help">
            ?
          </button>
        </div>

        {place === 'runs' && (
          <Runs
            person={person}
            usage={usage}
            onUsage={setUsage}
            onRefreshUsage={refreshUsage}
            onSignIn={() => setModal({ kind: 'sign-in', reason: 'Sign in to research: 3 runs a day, saved with your account.' })}
          />
        )}
        {place === 'memory' && (
          <MemoryPage
            signedIn={person !== null}
            userKey={userKey}
            adding={memoryAdding}
            setAdding={setMemoryAdding}
            onSignIn={() => setModal({ kind: 'sign-in', reason: 'Sign in to keep notes, links and files in your memory.' })}
            onExplain={explain}
          />
        )}
        {place === 'chat' &&
          (showWelcome ? (
            <section className="welcome" data-testid="welcome">
              <WrenMark size={44} state="idle" />
              <h2>What are we working on?</h2>
              {guestOn ? (
                <p data-testid="guest-intro">
                  Try Wren as a guest: {GUEST_LIMITS.chat} messages today, kept only in this tab.{' '}
                  <button type="button" className="linkbtn" onClick={() => setModal({ kind: 'sign-in', reason: null })}>
                    Sign in for 10x more messages, voice, research and memory
                  </button>
                </p>
              ) : (
                !person && <p>Ask anything. You&rsquo;ll sign in with GitHub or email before your first message.</p>
              )}
              <div className="sugs">
                {SUGGESTIONS.map((s) => (
                  <button key={s.text} type="button" className="sug" onClick={() => void run({ text: s.text })}>
                    <span style={{ color: s.tone, display: 'grid' }}>
                      <Icon name={s.icon} />
                    </span>
                    {s.text}
                  </button>
                ))}
              </div>
            </section>
          ) : loading ? (
            <div className="welcome" aria-busy="true">
              <WrenMark size={32} state="thinking" label="Loading chat" />
            </div>
          ) : (
            <Thread
              messages={shownMessages}
              streaming={streaming && streaming.chatId === chatId ? streaming : null}
              busy={streaming !== null}
              memory={person ? { chatId: loadedChatId, userKey } : null}
              researchLimit={DAILY_LIMITS.research}
              onRegenerate={regenerate}
              onResearchThis={researchThis}
              onResearchSettled={researchSettled}
              onResearchRetry={(question) => void startResearch(question)}
            />
          ))}

        {/* Where Turnstile shows itself, the rare times it wants an interaction. */}
        <div ref={turnstileBox} className="turnstile" data-testid="turnstile" />
        {place === 'chat' && (
          <Composer
            draft={draft}
            setDraft={setDraft}
            busy={streaming !== null}
            error={error}
            onDismissError={() => setError(null)}
            onSignIn={() => setModal({ kind: 'sign-in', reason: null })}
            onSend={send}
            onStop={stop}
            onExplain={explain}
            research={{
              on: researchOn,
              left: Math.max(0, usage.research.limit - usage.research.used),
              limit: usage.research.limit,
              starting: researchStarting,
            }}
            onResearch={toggleResearch}
            voice={voice.view}
            onMic={toggleVoice}
            focusKey={focusKey}
            notice={
              demoNoticeOn ? (
                <DemoNotice region={region} onKey={() => setModal({ kind: 'key' })} onDismiss={() => writeLocal(KEYS.demoNotice, '1')} />
              ) : null
            }
          />
        )}
        <BottomNav place={place} />
      </main>

      <HowItWorksDialog
        open={modal?.kind === 'how' || (firstVisit && modal === null)}
        onClose={closeHow}
        region={region}
        onKey={() => {
          writeLocal(KEYS.seenHow, '1')
          setModal({ kind: 'key' })
        }}
        onShowAround={() => {
          closeHow()
          saveTips({ active: true, step: 0 })
        }}
      />
      <SignInDialog
        open={modal?.kind === 'sign-in'}
        onClose={() => setModal(null)}
        reason={modal?.kind === 'sign-in' ? modal.reason : null}
        github={github}
      />
      <KeyDialog open={modal?.kind === 'key'} onClose={() => setModal(null)} current={userKey} onSave={saveKey} region={region} />
      <ExplainerDialog id={modal?.kind === 'explain' ? modal.id : null} onClose={() => setModal(null)} />
      <ConfirmDeleteDialog
        title={modal?.kind === 'delete' ? modal.chat.title : null}
        onCancel={() => setModal(null)}
        onConfirm={() => modal?.kind === 'delete' && void deleteChat(modal.chat)}
      />
      <Tips
        active={tips.active && modal === null && !menuOpen && !firstVisit}
        step={tips.step}
        onStep={(step) => saveTips({ active: true, step })}
        onClose={() => saveTips({ active: false, step: 0 })}
        onExplain={explain}
      />
    </div>
  )
}
