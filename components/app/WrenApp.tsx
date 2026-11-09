'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatSummary } from '@/agent/chats'
import { ApiError, api, sendGuestMessage, sendMessage } from '@/lib/client/api'
import { authClient } from '@/lib/client/auth-client'
import { GUEST_CHAT_KEY, KEYS, useLocalSetting, useSessionSetting, writeLocal, writeSession } from '@/lib/client/storage'
import { turnstileToken } from '@/lib/client/turnstile'
import { SIGN_IN_FIXES, errorMessage, isErrorCode } from '@/lib/errors'
import { DAILY_LIMITS, GUEST_LIMITS, nextUtcMidnight, type UsageSnapshot } from '@/lib/limits'
import type { ExplainerId } from '../explainers'
import { Icon } from '../Icons'
import { WrenMark } from '../WrenMark'
import { BottomNav, MobileHeader, Sidebar, type Person, type Place, type Theme } from './Chrome'
import { Composer } from './Composer'
import { ConfirmDeleteDialog, ExplainerDialog, HowItWorksDialog, KeyDialog, SignInDialog } from './Dialogs'
import { Thread, type StreamingAnswer } from './Thread'
import { Tips } from './Tips'

export interface WrenAppProps {
  person: Person | null
  github: boolean
  initialChats: ChatSummary[]
  initialUsage: UsageSnapshot | null
  /** Turnstile's public site key when guest chat is on; null means guests must sign in. */
  guestSiteKey: string | null
}

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
export function WrenApp({ person, github, initialChats, initialUsage, guestSiteKey }: WrenAppProps) {
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
  const [error, setErrorState] = useState<{ message: string; signIn: boolean } | null>(null)
  const setError = useCallback((message: string | null, signIn = false) => {
    setErrorState(message === null ? null : { message, signIn })
  }, [])
  const failWith = (failure: unknown) => {
    const code = failure instanceof ApiError ? failure.code : 'internal'
    setError(failure instanceof ApiError ? failure.message : errorMessage('internal'), isErrorCode(code) && SIGN_IN_FIXES.has(code))
  }
  const turnstileBox = useRef<HTMLDivElement>(null)
  const guestChat = parseGuestChat(useSessionSetting(GUEST_CHAT_KEY))
  const saveGuestChat = (next: GuestChat | null) => writeSession(GUEST_CHAT_KEY, next ? JSON.stringify(next) : null)
  const [draft, setDraft] = useState('')
  const [focusKey, setFocusKey] = useState(0)
  const [modal, setModal] = useState<Modal>(null)
  const [menu, setMenu] = useState<{ open: boolean; at: string }>({ open: false, at: pathname })
  // The title menu closes whenever the address changes or a dialog opens.
  if (menu.open && (menu.at !== pathname || modal !== null)) setMenu({ open: false, at: pathname })
  const menuOpen = menu.open && menu.at === pathname
  const setMenuOpen = (open: boolean) => setMenu({ open, at: pathname })

  const userKey = useLocalSetting(KEYS.geminiKey)
  const savedTheme = useLocalSetting(KEYS.theme)
  const theme: Theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'auto'
  // The server assumes the explainer was seen, so it only opens after hydration.
  const firstVisit = useLocalSetting(KEYS.seenHow, '1') === null
  const tips = parseTips(useLocalSetting(KEYS.tips))
  const abortRef = useRef<AbortController | null>(null)
  const streamChatRef = useRef<string | null>(null)
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
      if (streamChatRef.current === null) {
        setMessages([])
        setLoadedChatId(null)
      }
      return
    }
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
    setError(null)
    router.push(`/chat/${id}`)
  }

  const newChat = () => {
    setError(null)
    setDraft('')
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
      for await (const event of sendGuestMessage({
        text,
        history: earlier.map((m) => ({ role: m.role, text: m.content })).slice(-GUEST_LIMITS.historyTurns),
        userKey,
        signal: controller.signal,
        humanCheck: () => turnstileToken(turnstileBox.current ?? document.body, guestSiteKey),
      })) {
        if (event.t === 'start' && event.usage) setUsage(event.usage)
        else if (event.t === 'delta') {
          answer += event.text
          setStreaming((current) => (current ? { ...current, text: answer } : current))
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
    let finished: ChatMessage['status'] | null = null
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
          if (targetChat === null) window.history.replaceState(null, '', `/chat/${event.chat.id}`)
        } else if (event.t === 'delta') {
          text += event.text
          setStreaming((s) => (s ? { ...s, text } : s))
        } else if (event.t === 'done') {
          finished = event.status
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
      // Show the answer unless the person moved to another chat meanwhile. A
      // new chat's address may not have been committed yet, so the chat this
      // started in (none, for a new chat) counts as here too.
      const answeredChat = streamChatRef.current
      const stillHere = currentChatRef.current === answeredChat || currentChatRef.current === targetChat
      if (text && answerId && stillHere) {
        const status = finished ?? 'stopped'
        setMessages((list) => [...list, { id: answerId, role: 'model', content: text, status, createdAt: Date.now() }])
      }
      setStreaming(null)
      streamChatRef.current = null
      abortRef.current = null
      refreshUsage()
    }
  }

  const send = () => {
    const text = draft.trim()
    if (!text || streaming) return
    setDraft('')
    void run({ text })
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
    setModal(null)
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
    onMemoryAdd: () => explain('memory'),
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
          <section className="soonpage" data-testid="runs-page">
            <span className="hi c-sa">
              <Icon name="res" />
            </span>
            <span className="tag">Coming in the next update</span>
            <h2>Research runs</h2>
            <p>
              Ask Wren to research something and it will plan searches, read the pages and write an answer that cites only what it
              opened. Every run will be listed here, and keeps going if you close the tab.
            </p>
            <button type="button" className="btn" onClick={() => explain('research')}>
              How research will work
            </button>
          </section>
        )}
        {place === 'memory' && (
          <section className="soonpage" data-testid="memory-page">
            <span className="hi c-sg">
              <Icon name="mem" />
            </span>
            <span className="tag">Coming in the next update</span>
            <h2>Memory</h2>
            <p>
              A library of notes, files and links you save. Wren will check it first and link back to whatever it used in an
              answer. You&rsquo;ll be able to search it, browse it and delete anything at any time.
            </p>
            <button type="button" className="btn" onClick={() => explain('memory')}>
              How Memory will work
            </button>
          </section>
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
              onRegenerate={regenerate}
              onExplain={explain}
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
            focusKey={focusKey}
          />
        )}
        <BottomNav place={place} />
      </main>

      <HowItWorksDialog
        open={modal?.kind === 'how' || (firstVisit && modal === null)}
        onClose={closeHow}
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
      <KeyDialog open={modal?.kind === 'key'} onClose={() => setModal(null)} current={userKey} onSave={saveKey} />
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
