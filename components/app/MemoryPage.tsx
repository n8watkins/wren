'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ApiError } from '@/lib/client/api'
import { memoryApi } from '@/lib/client/memory-api'
import { errorMessage, isErrorCode } from '@/lib/errors'
import {
  MEMORY_FILE_ACCEPT,
  MEMORY_LIMITS,
  formatBytes,
  matchesWords,
  type Memory,
  type MemoryKind,
  type MemoryUsage,
} from '@/lib/memory'
import type { ExplainerId } from '../explainers'
import { Icon, type IconName } from '../Icons'
import { WrenMark } from '../WrenMark'
import styles from './MemoryPage.module.css'

/**
 * The Memory library (/memory): everything the person saved and every fact
 * Wren kept, with search (words at once, meaning after a pause), a filter by
 * kind, inline edit, delete with a confirm on the item itself, adding a note,
 * link or file, and how much of the caps is used. Guests get none.
 */

type Filter = 'all' | MemoryKind
export type MemoryAdding = 'note' | 'link' | 'file' | null

const KIND: Record<MemoryKind, { icon: IconName; one: string; many: string }> = {
  fact: { icon: 'fact', one: 'Fact', many: 'Facts' },
  note: { icon: 'note', one: 'Note', many: 'Notes' },
  link: { icon: 'link', one: 'Link', many: 'Links' },
  file: { icon: 'file', one: 'File', many: 'Files' },
}

const FILTERS: Filter[] = ['all', 'fact', 'note', 'link', 'file']

/** How long typing must pause before a search by meaning is sent. */
const MEANING_DELAY_MS = 600

function messageOf(failure: unknown): string {
  return failure instanceof ApiError ? failure.message : errorMessage('internal')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function dateOf(ms: number): string {
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export function MemoryPage({
  signedIn,
  userKey,
  adding,
  setAdding,
  onSignIn,
  onExplain,
}: {
  signedIn: boolean
  userKey: string | null
  /** The open add form (the shell holds it, so the sidebar's "+" can open it from any page). */
  adding: MemoryAdding
  setAdding: (adding: MemoryAdding) => void
  onSignIn: () => void
  onExplain: (id: ExplainerId) => void
}) {
  if (!signedIn) {
    return (
      <section className="soonpage" data-testid="memory-page">
        <span className="hi c-sg">
          <Icon name="mem" />
        </span>
        <h2>Your memory</h2>
        <p>
          A library of notes, links and files you save, plus lasting facts Wren keeps from your chats, all searchable by meaning.
          Guests get no memory, as nothing of theirs is saved past the tab.
        </p>
        <button type="button" className="btn pri" onClick={onSignIn} data-testid="memory-sign-in">
          Sign in to start your memory
        </button>
      </section>
    )
  }
  return <Library userKey={userKey} adding={adding} setAdding={setAdding} onExplain={onExplain} />
}

function Library({
  userKey,
  adding,
  setAdding,
  onExplain,
}: {
  userKey: string | null
  adding: MemoryAdding
  setAdding: (adding: MemoryAdding) => void
  onExplain: (id: ExplainerId) => void
}) {
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [usage, setUsage] = useState<MemoryUsage>({ count: 0, limit: MEMORY_LIMITS.count, bytes: 0, byteLimit: MEMORY_LIMITS.fileBytes })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [found, setFound] = useState<{ query: string; ids: string[]; meaning: boolean } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    memoryApi.list({ userKey: null }).then(
      (list) => {
        if (cancelled) return
        setMemories(list.memories)
        setUsage(list.usage)
      },
      (failure: unknown) => !cancelled && setLoadError(messageOf(failure))
    )
    return () => {
      cancelled = true
    }
  }, [attempt])
  const retry = () => {
    setLoadError(null)
    setAttempt((n) => n + 1)
  }

  // Search by meaning once typing pauses; words are matched at once, below.
  const trimmed = query.trim()
  useEffect(() => {
    if (trimmed.length < 3) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setSearching(true)
      memoryApi
        .list({ query: trimmed, userKey, signal: controller.signal })
        .then(
          (list) => {
            setFound({ query: trimmed, ids: list.memories.map((m) => m.id), meaning: list.meaning })
            setNotice(list.notice ? errorMessage(list.notice) : null)
          },
          () => undefined
        )
        .finally(() => !controller.signal.aborted && setSearching(false))
    }, MEANING_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trimmed, userKey])

  const all = useMemo(() => memories ?? [], [memories])
  const counts = useMemo(() => {
    const byKind: Record<Filter, number> = { all: all.length, fact: 0, note: 0, link: 0, file: 0 }
    for (const memory of all) byKind[memory.kind]++
    return byKind
  }, [all])

  // Word matches straight away, then whatever the meaning search added, in its order.
  const shown = useMemo(() => {
    const ofKind = all.filter((m) => filter === 'all' || m.kind === filter)
    if (!trimmed) return ofKind.map((memory) => ({ memory, related: false }))
    const words = ofKind.filter((m) => matchesWords(m, trimmed))
    const wordIds = new Set(words.map((m) => m.id))
    const byId = new Map(ofKind.map((m) => [m.id, m]))
    const related =
      found?.query === trimmed
        ? found.ids.filter((id) => !wordIds.has(id) && byId.has(id)).map((id) => byId.get(id) as Memory)
        : []
    return [...words.map((memory) => ({ memory, related: false })), ...related.map((memory) => ({ memory, related: true }))]
  }, [all, filter, trimmed, found])

  const saved = (memory: Memory) => {
    setMemories((list) => [memory, ...(list ?? []).filter((m) => m.id !== memory.id)])
    setUsage((u) => ({ ...u, count: u.count + 1, bytes: u.bytes + (memory.file?.size ?? 0) }))
    setFound(null)
    setAdding(null)
    setError(null)
  }
  const changed = (memory: Memory) => {
    setMemories((list) => (list ?? []).map((m) => (m.id === memory.id ? memory : m)))
    setFound(null)
  }
  const removed = (memory: Memory) => {
    setMemories((list) => (list ?? []).filter((m) => m.id !== memory.id))
    setUsage((u) => ({ ...u, count: Math.max(0, u.count - 1), bytes: Math.max(0, u.bytes - (memory.file?.size ?? 0)) }))
  }

  const full = usage.count >= usage.limit

  return (
    <section className={styles.page} data-testid="memory-page">
      <div className={styles.col}>
        <div className={styles.top}>
          <UsageBars usage={usage} />
          <div className={styles.adds} role="group" aria-label="Add to Memory">
            {(['note', 'link', 'file'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={adding === kind ? `${styles.add} ${styles.on}` : styles.add}
                aria-pressed={adding === kind}
                disabled={full}
                onClick={() => setAdding(adding === kind ? null : kind)}
                data-testid={`memory-add-${kind}`}
              >
                <Icon name={KIND[kind].icon} />
                Add {KIND[kind].one.toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        {full && (
          <p className={styles.warn} data-testid="memory-full">
            <Icon name="alert" />
            {errorMessage('memory_full')}
          </p>
        )}
        {adding && (
          <AddForm
            kind={adding}
            userKey={userKey}
            usage={usage}
            onSaved={saved}
            onCancel={() => setAdding(null)}
          />
        )}

        {all.length > 0 && (
          <div className={styles.tools}>
            <label className={styles.search}>
              <Icon name="search" />
              <span className="sr-only">Search your memory</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by words or meaning"
                maxLength={MEMORY_LIMITS.queryChars}
                enterKeyHint="search"
                data-testid="memory-search"
              />
              {searching && trimmed.length >= 3 && <WrenMark size={18} state="thinking" label="Searching by meaning" />}
            </label>
            <div className={styles.chips} role="group" aria-label="Show">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={filter === f ? `${styles.chip} ${styles.on}` : styles.chip}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                  data-testid={`memory-filter-${f}`}
                >
                  {f === 'all' ? 'All' : KIND[f].many}
                  <span className={styles.n}>{counts[f]}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {notice && <p className={styles.warn}>{notice}</p>}
        {error && (
          <div className="alert" role="alert">
            <Icon name="alert" />
            <p>{error}</p>
            <button type="button" className="dismiss" aria-label="Dismiss" onClick={() => setError(null)}>
              <Icon name="x" />
            </button>
          </div>
        )}

        {loadError ? (
          <div className={styles.empty}>
            <p>{loadError}</p>
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </div>
        ) : memories === null ? (
          <div className={styles.empty} aria-busy="true">
            <WrenMark size={32} state="thinking" label="Loading your memory" />
          </div>
        ) : all.length === 0 ? (
          <div className={styles.empty} data-testid="memory-empty">
            <span className="hi c-sg">
              <Icon name="mem" />
            </span>
            <h2>Nothing saved yet</h2>
            <p>
              Add a note, a link or a text, Markdown or PDF file, and find it later by what it means, not just its words. Soon
              Wren will also keep lasting facts from your chats here, and check them before it answers.
            </p>
            <button type="button" className="linkbtn" onClick={() => onExplain('memory')}>
              How Memory works
            </button>
          </div>
        ) : shown.length === 0 && trimmed.length >= 3 && found?.query !== trimmed ? (
          <div className={styles.empty} aria-busy="true">
            <WrenMark size={28} state="thinking" label="Searching by meaning" />
            <p>Looking for memories that mean the same…</p>
          </div>
        ) : shown.length === 0 ? (
          <div className={styles.empty} data-testid="memory-none">
            <p>{trimmed ? `Nothing matches “${trimmed}”${filter === 'all' ? '' : ` in ${KIND[filter].many.toLowerCase()}`}.` : `No ${filter === 'all' ? 'memories' : KIND[filter].many.toLowerCase()} yet.`}</p>
          </div>
        ) : (
          <ul className={styles.list} aria-label="Memories">
            {shown.map(({ memory, related }, i) => (
              <MemoryItem
                key={memory.id}
                memory={memory}
                firstRelated={related && !shown[i - 1]?.related}
                userKey={userKey}
                onChanged={changed}
                onRemoved={removed}
                onError={setError}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function UsageBars({ usage }: { usage: MemoryUsage }) {
  const items = [
    { value: String(usage.count), rest: `of ${usage.limit} memories`, pct: usage.count / usage.limit, testId: 'memory-usage-count' },
    { value: formatBytes(usage.bytes), rest: `of ${formatBytes(usage.byteLimit)} in files`, pct: usage.bytes / usage.byteLimit, testId: 'memory-usage-bytes' },
  ]
  return (
    <div className={styles.usage}>
      {items.map((item) => (
        <div key={item.testId} className={styles.urow}>
          <span data-testid={item.testId}>
            <b>{item.value}</b> {item.rest}
          </span>
          <span className={styles.bar} aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(item.pct > 0 ? 2 : 0, item.pct * 100))}%` }} className={item.pct >= 0.9 ? styles.hot : undefined} />
          </span>
        </div>
      ))}
    </div>
  )
}

function AddForm({
  kind,
  userKey,
  usage,
  onSaved,
  onCancel,
}: {
  kind: 'note' | 'link' | 'file'
  userKey: string | null
  usage: MemoryUsage
  onSaved: (memory: Memory) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const run = async (label: string, work: () => Promise<Memory>) => {
    setBusy(label)
    setError(null)
    try {
      onSaved(await work())
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(null)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (kind === 'note' && text.trim()) void run('Saving…', () => memoryApi.addNote(text.trim(), userKey))
    if (kind === 'link' && url.trim()) {
      const address = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`
      void run('Saving…', () => memoryApi.addLink(address, title.trim(), userKey))
    }
  }

  const upload = (file: File | undefined) => {
    if (!file || busy) return
    if (file.size > MEMORY_LIMITS.fileMaxBytes) return setError(errorMessage('memory_file_too_large'))
    if (usage.bytes + file.size > usage.byteLimit) return setError(errorMessage('memory_files_full'))
    void run(`Reading ${file.name}…`, () => memoryApi.upload(file, userKey)).finally(() => {
      if (fileInput.current) fileInput.current.value = ''
    })
  }

  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onCancel()
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event)
  }

  return (
    <form className={styles.form} onSubmit={submit} onKeyDown={keys} data-testid="memory-add-form" aria-label={`Add a ${kind}`}>
      {kind === 'note' && (
        <div className="field">
          <label htmlFor="memory-note">Note</label>
          <textarea
            id="memory-note"
            className={styles.area}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MEMORY_LIMITS.noteChars}
            rows={4}
            placeholder="Anything you want Wren to remember"
            autoFocus
            data-testid="memory-note-text"
          />
          {text.length > MEMORY_LIMITS.noteChars * 0.8 && (
            <small className={styles.count}>
              {text.length} / {MEMORY_LIMITS.noteChars}
            </small>
          )}
        </div>
      )}
      {kind === 'link' && (
        <>
          <div className="field">
            <label htmlFor="memory-url">Address</label>
            <input
              id="memory-url"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              maxLength={MEMORY_LIMITS.urlChars}
              placeholder="https://"
              autoFocus
              data-testid="memory-link-url"
            />
          </div>
          <div className="field">
            <label htmlFor="memory-title">Title (optional)</label>
            <input
              id="memory-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={MEMORY_LIMITS.titleChars}
              placeholder="What it is, in your words"
              data-testid="memory-link-title"
            />
          </div>
        </>
      )}
      {kind === 'file' && (
        <label
          className={busy ? `${styles.drop} ${styles.busy}` : styles.drop}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            upload(event.dataTransfer.files[0])
          }}
        >
          <Icon name="file" />
          <span>
            <b>{busy ?? 'Choose a file or drop it here'}</b>
            <small>Text, Markdown or PDF, up to {formatBytes(MEMORY_LIMITS.fileMaxBytes)}</small>
          </span>
          <input
            ref={fileInput}
            type="file"
            accept={MEMORY_FILE_ACCEPT}
            className="sr-only"
            disabled={busy !== null}
            onChange={(event) => upload(event.target.files?.[0])}
            data-testid="memory-file-input"
          />
        </label>
      )}
      {error && (
        <p className="formerr" role="alert">
          {error}
        </p>
      )}
      <div className={styles.formfoot}>
        <span className={styles.hint}>
          {kind === 'link' ? 'Wren keeps the address and your title; it doesn’t open the page.' : kind === 'note' ? 'Searchable by meaning once saved.' : ''}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        {kind !== 'file' && (
          <button
            type="submit"
            className={`btn ${styles.save}`}
            disabled={busy !== null || (kind === 'note' ? !text.trim() : !url.trim())}
            data-testid="memory-save"
          >
            {busy ?? (kind === 'note' ? 'Save note' : 'Save link')}
          </button>
        )}
      </div>
    </form>
  )
}

function MemoryItem({
  memory,
  firstRelated,
  userKey,
  onChanged,
  onRemoved,
  onError,
}: {
  memory: Memory
  firstRelated: boolean
  userKey: string | null
  onChanged: (memory: Memory) => void
  onRemoved: (memory: Memory) => void
  onError: (message: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ title: memory.title, text: memory.text, url: memory.url ?? '' })
  const [editError, setEditError] = useState<string | null>(null)
  const kind = KIND[memory.kind]

  const startEdit = () => {
    setDraft({ title: memory.title, text: memory.text, url: memory.url ?? '' })
    setEditError(null)
    setConfirming(false)
    setEditing(true)
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const patch =
      memory.kind === 'file'
        ? { title: draft.title.trim() }
        : memory.kind === 'link'
          ? { title: draft.title.trim(), url: draft.url.trim() }
          : { text: draft.text.trim() }
    setBusy(true)
    setEditError(null)
    try {
      onChanged(await memoryApi.update(memory.id, patch, userKey))
      setEditing(false)
    } catch (failure) {
      setEditError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await memoryApi.remove(memory.id)
      onRemoved(memory)
    } catch (failure) {
      // Already gone counts as deleted.
      if (failure instanceof ApiError && isErrorCode(failure.code) && failure.code === 'memory_not_found') onRemoved(memory)
      else {
        onError(messageOf(failure))
        setBusy(false)
        setConfirming(false)
      }
    }
  }

  const heading =
    memory.kind === 'link' ? (
      <a href={memory.url ?? '#'} target="_blank" rel="noopener noreferrer nofollow" className={styles.title}>
        {memory.title || hostOf(memory.url ?? '')}
      </a>
    ) : memory.kind === 'file' ? (
      <a href={memoryApi.fileUrl(memory.id)} download={memory.file?.name} className={styles.title}>
        {memory.title || memory.file?.name}
      </a>
    ) : null

  return (
    <li className={styles.item} data-testid="memory-item" data-kind={memory.kind}>
      {firstRelated && <span className={styles.relhead}>Related by meaning</span>}
      <div className={styles.card}>
        <span className={`${styles.ki} c-sg`} title={kind.one}>
          <Icon name={kind.icon} />
        </span>
        <div className={styles.body}>
          {editing ? (
            <form
              className={styles.edit}
              onSubmit={save}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setEditing(false)
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save(event)
              }}
              aria-label={`Edit this ${kind.one.toLowerCase()}`}
            >
              {(memory.kind === 'link' || memory.kind === 'file') && (
                <input
                  className={styles.input}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  maxLength={MEMORY_LIMITS.titleChars}
                  placeholder="Title"
                  aria-label="Title"
                  autoFocus
                  data-testid="memory-edit-title"
                />
              )}
              {memory.kind === 'link' && (
                <input
                  className={styles.input}
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={draft.url}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  maxLength={MEMORY_LIMITS.urlChars}
                  aria-label="Address"
                />
              )}
              {(memory.kind === 'note' || memory.kind === 'fact') && (
                <textarea
                  className={styles.area}
                  value={draft.text}
                  onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                  maxLength={memory.kind === 'fact' ? MEMORY_LIMITS.factChars : MEMORY_LIMITS.noteChars}
                  rows={Math.min(8, Math.max(2, Math.ceil(draft.text.length / 70)))}
                  aria-label="Text"
                  autoFocus
                  data-testid="memory-edit-text"
                />
              )}
              {editError && (
                <p className="formerr" role="alert">
                  {editError}
                </p>
              )}
              <div className={styles.formfoot}>
                <span className={styles.hint} />
                <button type="button" className="btn" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button type="submit" className={`btn ${styles.save}`} disabled={busy} data-testid="memory-edit-save">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          ) : (
            <>
              {heading}
              {memory.kind === 'link' && memory.url && <span className={styles.host}>{hostOf(memory.url)}</span>}
              {memory.text && (
                <p className={memory.kind === 'file' ? `${styles.text} ${styles.excerpt}` : styles.text} data-testid="memory-text">
                  {memory.text}
                </p>
              )}
              <div className={styles.meta}>
                <span>{kind.one}</span>
                <span>
                  {memory.origin === 'wren' ? (
                    memory.sourceChatId ? (
                      <>
                        Saved by Wren from <a href={`/chat/${memory.sourceChatId}`}>a chat</a>
                      </>
                    ) : (
                      'Saved by Wren'
                    )
                  ) : (
                    'Saved by you'
                  )}
                </span>
                <span>{dateOf(memory.updatedAt)}</span>
                {memory.file && <span>{formatBytes(memory.file.size)}</span>}
                {!memory.indexed && (
                  <span className={styles.pending} title="Search by meaning will include it once Gemini is available. Words find it now.">
                    Words only for now
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        {!editing && !confirming && (
          <div className={styles.acts}>
            <button type="button" onClick={startEdit} aria-label={`Edit this ${kind.one.toLowerCase()}`} title="Edit" data-testid="memory-edit">
              <Icon name="edit" />
            </button>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Delete this ${kind.one.toLowerCase()}`}
              title="Delete"
              data-testid="memory-delete"
            >
              <Icon name="trash" />
            </button>
          </div>
        )}
      </div>
      {confirming && (
        <div className={styles.confirm} role="alertdialog" aria-label="Delete this memory?" data-testid="memory-confirm">
          <p>
            <b>Delete for good?</b>{' '}
            {memory.kind === 'file' ? 'The file and its text are removed everywhere.' : 'It’s removed from search too.'}
          </p>
          <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy} autoFocus>
            Keep it
          </button>
          <button type="button" className={`btn ${styles.danger}`} onClick={() => void remove()} disabled={busy} data-testid="memory-confirm-delete">
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
    </li>
  )
}
