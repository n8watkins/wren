'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ApiError } from '@/lib/client/api'
import { memoryApi, memoryHref } from '@/lib/client/memory-api'
import { errorMessage } from '@/lib/errors'
import type { AutoSave, RecalledMemory } from '@/lib/memory'
import { Icon } from '../Icons'

/**
 * Memory in the chat thread, for signed-in people only: the "From your
 * Memory" chips on an answer, the "Saved to Memory · Undo" lines under a
 * message Wren saved facts from, and the "Save to Memory" button.
 */

/** What the thread needs to talk to Memory; null for guests, who get none of this. */
export interface ThreadMemory {
  /** The chat the messages are in (null until a new chat has its id). */
  chatId: string | null
  userKey: string | null
}

function messageOf(failure: unknown): string {
  return failure instanceof ApiError ? failure.message : errorMessage('internal')
}

/** The memories Wren used for an answer; each opens on the Memory page. */
export function RecallChips({ memories }: { memories: RecalledMemory[] }) {
  return (
    <div className="recall" data-testid="recall">
      <span className="lbl">From your Memory</span>
      {memories.map((memory) => (
        <Link key={memory.id} href={memoryHref(memory.id)} className="rchip" title={memory.label} data-testid="recall-chip">
          <Icon name={memory.kind} />
          <span>{memory.label}</span>
        </Link>
      ))}
    </div>
  )
}

/** One line per fact Wren saved from a message, each with Undo. */
export function SavedLines({ saves, memory }: { saves: AutoSave[]; memory: ThreadMemory }) {
  return (
    <div className="saved-lines">
      {saves.map((save) => (
        <SavedLine key={save.id} save={save} memory={memory} />
      ))}
    </div>
  )
}

function SavedLine({ save, memory }: { save: AutoSave; memory: ThreadMemory }) {
  const [undone, setUndone] = useState(save.undone)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const undo = async () => {
    if (!memory.chatId || busy) return
    setBusy(true)
    setError(null)
    try {
      await memoryApi.undoSave(memory.chatId, save.id, memory.userKey)
      setUndone(true)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }
  const status = undone
    ? save.action === 'updated'
      ? 'Change undone'
      : 'Removed from Memory'
    : save.action === 'updated'
      ? 'Updated in Memory'
      : 'Saved to Memory'
  return (
    <div className={undone ? 'saved off' : 'saved'} data-testid="memory-saved" data-undone={undone || undefined}>
      <Icon name={undone ? 'redo' : 'check'} />
      <span className="st">{status}</span>
      {undone ? (
        <span className="fact">{save.text}</span>
      ) : (
        <Link href={memoryHref(save.memoryId)} className="fact" title={save.text}>
          {save.text}
        </Link>
      )}
      {!undone && (
        <button type="button" onClick={() => void undo()} disabled={busy} data-testid="memory-undo">
          {busy ? 'Undoing…' : 'Undo'}
        </button>
      )}
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

/**
 * "Save to Memory" on a message. Once saved it reads "Saved" and opens the
 * memory; a click while saving does nothing, and the server saves a message
 * once however often it is asked. `compact` is the icon-only button beside your
 * own messages.
 */
export function SaveToMemory({
  messageId,
  savedAs,
  memory,
  compact = false,
  label = 'Save to memory',
}: {
  messageId: string
  savedAs?: string
  memory: ThreadMemory
  compact?: boolean
  /** The button's words ("Save findings to memory" on a research report). */
  label?: string
}) {
  const [saved, setSaved] = useState<string | null>(savedAs ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chatId = memory.chatId

  if (saved) {
    return (
      <Link
        href={memoryHref(saved)}
        className={compact ? 'umem on' : 'mem on'}
        aria-label={compact ? 'Saved to memory: open it' : undefined}
        title="Saved to memory: open it"
        data-testid="save-to-memory"
        data-saved="true"
      >
        <Icon name="check" />
        {!compact && 'Saved to memory'}
      </Link>
    )
  }

  const save = async () => {
    if (!chatId || busy) return
    setBusy(true)
    setError(null)
    try {
      const saved = await memoryApi.saveMessage(chatId, messageId, memory.userKey)
      setSaved(saved.id)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className={compact ? 'umem' : 'mem'}
        onClick={() => void save()}
        disabled={busy || !chatId}
        aria-label={compact ? 'Save to memory' : undefined}
        title={compact ? 'Save to memory' : undefined}
        data-testid="save-to-memory"
      >
        <Icon name="mem" />
        {!compact && (busy ? 'Saving…' : label)}
      </button>
      {error && (
        <span className="memerr" role="alert">
          {error}
        </span>
      )}
    </>
  )
}
