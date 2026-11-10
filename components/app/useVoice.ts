'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatSummary } from '@/agent/chats'
import type { UsageSnapshot } from '@/lib/limits'
import type { MessageMemory } from '@/lib/memory'
import { VoiceSession, type VoiceProblem, type VoiceStatus } from '@/lib/client/voice'

/** What the listening view shows. */
export interface VoiceView {
  status: VoiceStatus
  /** The words of the turn being spoken, until it is saved. */
  interim: { role: 'user' | 'model'; text: string } | null
  /** Seconds left today when `at` was read, or null on the person's own key (or not known yet). */
  left: { seconds: number; at: number } | null
  ownKey: boolean
}

interface VoiceHandlers {
  onMessage(chat: ChatSummary, message: ChatMessage): void
  onMarks(messageId: string, memory: MessageMemory | null): void
  onUsage(usage: UsageSnapshot): void
  onEnded(problem: VoiceProblem | null): void
}

/**
 * One conversation out loud at a time. The mic level goes straight to a CSS
 * variable (--voice-level) rather than through React, as it changes ten times
 * a second.
 */
export function useVoice(handlers: VoiceHandlers) {
  const [view, setView] = useState<VoiceView | null>(null)
  const session = useRef<VoiceSession | null>(null)
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  const setLevel = (level: number) => document.documentElement.style.setProperty('--voice-level', level.toFixed(2))

  const start = useCallback((options: { chatId: string | null; userKey: string | null }) => {
    if (session.current) return
    const ownKey = Boolean(options.userKey)
    setView({ status: 'connecting', interim: null, left: null, ownKey })
    const current: VoiceSession = new VoiceSession({
      status: (status) => setView((v) => (v ? { ...v, status } : v)),
      level: setLevel,
      interim: (role, text) => setView((v) => (v ? { ...v, interim: text ? { role, text } : null } : v)),
      message: (chat, message) => latest.current.onMessage(chat, message),
      marks: (messageId, memory) => latest.current.onMarks(messageId, memory),
      usage: (usage, secondsLeft) => {
        if (usage) latest.current.onUsage(usage)
        setView((v) => (v ? { ...v, left: secondsLeft === null ? null : { seconds: secondsLeft, at: Date.now() } } : v))
      },
      ended: (problem) => {
        if (session.current === current) session.current = null
        setLevel(0)
        setView(null)
        latest.current.onEnded(problem)
      },
    })
    session.current = current
    void current.start(options)
  }, [])

  const stop = useCallback(() => session.current?.stop(), [])
  const sendText = useCallback((text: string) => session.current?.sendText(text) ?? false, [])

  // Leaving the page ends the session and frees the mic.
  useEffect(() => () => session.current?.stop(), [])

  return { view, start, stop, sendText }
}
