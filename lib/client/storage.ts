'use client'

import { useSyncExternalStore } from 'react'

/**
 * Per-browser conveniences in localStorage, every access guarded: private
 * windows and blocked storage just mean nothing is remembered. Components read
 * them through useLocalSetting, which re-renders on changes from this tab
 * (writeLocal) and other tabs (the storage event), and renders the server's
 * value during hydration so nothing mismatches.
 */
export const KEYS = {
  geminiKey: 'wren:gemini-key',
  seenHow: 'wren:seen-how-it-works',
  tips: 'wren:tips',
  theme: 'wren:theme',
} as const

/** A guest's chat: only in this tab (sessionStorage), never on the server. */
export const GUEST_CHAT_KEY = 'wren:guest-chat'

const CHANGE = 'wren:local-change'

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: nothing is remembered.
  }
  window.dispatchEvent(new Event(CHANGE))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE, onChange)
  }
}

/** A localStorage value; `serverValue` is what the server render (and hydration) assume. */
export function useLocalSetting(key: string, serverValue: string | null = null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readLocal(key),
    () => serverValue
  )
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeSession(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the chat lasts as long as the page.
  }
  window.dispatchEvent(new Event(CHANGE))
}

/** A sessionStorage value for this tab; null while rendering on the server. */
export function useSessionSetting(key: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readSession(key),
    () => null
  )
}
