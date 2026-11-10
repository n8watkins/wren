/**
 * Memory's shapes and caps, shared by the agent, the API and the Memory page.
 * The caps are the owner's demo placeholders (2026-11-09): 500 memories and
 * 25 MB of files per person, enforced in the person's agent and shown on the
 * page. Change them here and nowhere else.
 */

export type MemoryKind = 'fact' | 'note' | 'link' | 'file'
export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'note', 'link', 'file']

/** Who saved it: Wren on its own (from a chat), or the person. */
export type MemoryOrigin = 'wren' | 'you'

interface MemoryFile {
  name: string
  type: MemoryFileType
  size: number
}

export interface Memory {
  id: string
  kind: MemoryKind
  /** A link's or file's title; empty for facts and notes. */
  title: string
  /** The fact or note itself, a link's description, or a file's text (shortened in lists). */
  text: string
  url: string | null
  file: MemoryFile | null
  origin: MemoryOrigin
  sourceChatId: string | null
  sourceMessageId: string | null
  /** Whether it can be found by meaning yet (its embedding is stored). Words always find it. */
  indexed: boolean
  createdAt: number
  updatedAt: number
}

/** A memory Wren gave the model before an answer, shown as a "From your Memory" chip on it. */
export interface RecalledMemory {
  id: string
  kind: MemoryKind
  /** A short label: the title, or the start of the text. */
  label: string
}

/** A fact Wren saved on its own after an answer, shown as "Saved to Memory · Undo" under the message it came from. */
export interface AutoSave {
  /** This save's own id (what Undo names), not the memory's. */
  id: string
  memoryId: string
  /** Added a new fact, or updated one Wren saved before. */
  action: 'added' | 'updated'
  text: string
  undone: boolean
}

/** Memory's marks on one chat message, saved with the chat so a reload shows them. */
export interface MessageMemory {
  /** On an answer: what Wren recalled for it. */
  recalled?: RecalledMemory[]
  /** On your message: facts Wren saved from it. */
  saves?: AutoSave[]
  /** The memory this message was saved as with "Save to Memory". */
  savedAs?: string
}

export interface MemoryUsage {
  count: number
  limit: number
  bytes: number
  byteLimit: number
}

export const MEMORY_LIMITS = {
  /** Memories one person keeps. */
  count: 500,
  /** Bytes of files one person keeps. */
  fileBytes: 25 * 1024 * 1024,
  /** Bytes in one file. */
  fileMaxBytes: 5 * 1024 * 1024,
  /** Characters in a note. */
  noteChars: 4_000,
  /** Characters in a fact Wren saves. */
  factChars: 300,
  /** Characters in a title. */
  titleChars: 200,
  /** Characters in a link. */
  urlChars: 2_048,
  /** Characters of a file's text kept for search and quoting. */
  fileTextChars: 50_000,
  /** Characters of a file's text sent to the page in a list. */
  excerptChars: 400,
  /** Characters in a search. */
  queryChars: 200,
  /** Gemini calls (embeddings, reading a PDF, picking facts) a day on the demo key. */
  dailyAiCalls: 200,
  /** Facts Wren saves from one turn of a conversation. */
  factsPerTurn: 3,
  /** The person's own recent messages the extractor reads. */
  extractorMessages: 4,
  /** Memories Wren recalls for one answer, at most. */
  recallCount: 4,
  /** Characters of one recalled memory given to the model (a file's start). */
  recallChars: 1_200,
  /** Characters in a recall chip's label. */
  labelChars: 60,
} as const

/**
 * The embedding size. gemini-embedding-2 answers 3072 by default and accepts
 * 128 to 3072; Vectorize takes at most 1536, and 768 is one of Google's
 * recommended sizes. The wren-memory index was created with this many.
 */
export const EMBEDDING_DIMENSIONS = 768

/** The files Memory reads, by extension (browsers disagree on Markdown's MIME type). */
const MEMORY_FILE_TYPES = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
} as const

export type MemoryFileType = (typeof MEMORY_FILE_TYPES)[keyof typeof MEMORY_FILE_TYPES]

/** The type a file name says it is, or null for one Memory doesn't read. */
export function fileTypeFor(name: string): MemoryFileType | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase()
  if (!ext || !Object.hasOwn(MEMORY_FILE_TYPES, ext)) return null
  return MEMORY_FILE_TYPES[ext as keyof typeof MEMORY_FILE_TYPES]
}

export const MEMORY_FILE_ACCEPT = '.txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf'

/** "1.2 MB", "340 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

function normalizeWords(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Whether every word of a search is somewhere in the memory (title, text, link or file name). */
export function matchesWords(memory: Pick<Memory, 'title' | 'text' | 'url' | 'file'>, query: string): boolean {
  const words = normalizeWords(query).split(' ').filter(Boolean)
  if (words.length === 0) return true
  const haystack = normalizeWords([memory.title, memory.text, memory.url ?? '', memory.file?.name ?? ''].join(' '))
  return words.every((word) => haystack.includes(word))
}
