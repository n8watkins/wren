import type { Sql } from './sql'
import { MEMORY_LIMITS, type Memory, type MemoryFileType, type MemoryKind, type MemoryOrigin, type MemoryUsage } from '../lib/memory'

/**
 * One person's memories, in their own agent's SQLite database beside their
 * chats. Like agent/chats.ts, nothing here takes a person's id: the Durable
 * Object instance is the person. Search vectors live in agent/memory-vectors.ts
 * and files in R2; agent/memory.ts keeps the three in step.
 */

type MemoryRow = {
  id: string
  kind: string
  title: string
  text: string
  url: string | null
  file_key: string | null
  file_name: string | null
  file_size: number | null
  file_type: string | null
  origin: string
  source_chat_id: string | null
  source_message_id: string | null
  indexed: number
  created_at: number
  updated_at: number
}

export function createMemoryTables(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'note', 'link', 'file')),
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    url TEXT,
    file_key TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('wren', 'you')),
    source_chat_id TEXT,
    source_message_id TEXT,
    indexed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS memories_by_time ON memories (updated_at)')
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    title: row.title,
    text: row.text,
    url: row.url,
    file:
      row.file_name !== null && row.file_size !== null && row.file_type !== null
        ? { name: row.file_name, size: row.file_size, type: row.file_type as MemoryFileType }
        : null,
    origin: row.origin as MemoryOrigin,
    sourceChatId: row.source_chat_id,
    sourceMessageId: row.source_message_id,
    indexed: row.indexed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface NewMemory {
  kind: MemoryKind
  title?: string
  text: string
  url?: string | null
  file?: { key: string; name: string; size: number; type: MemoryFileType } | null
  origin: MemoryOrigin
  sourceChatId?: string | null
  sourceMessageId?: string | null
}

export function insertMemory(sql: Sql, input: NewMemory, id: string = crypto.randomUUID(), now = Date.now()): Memory {
  sql.exec(
    `INSERT INTO memories (id, kind, title, text, url, file_key, file_name, file_size, file_type, origin,
      source_chat_id, source_message_id, indexed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    id,
    input.kind,
    input.title ?? '',
    input.text,
    input.url ?? null,
    input.file?.key ?? null,
    input.file?.name ?? null,
    input.file?.size ?? null,
    input.file?.type ?? null,
    input.origin,
    input.sourceChatId ?? null,
    input.sourceMessageId ?? null,
    now,
    now
  )
  const saved = getMemory(sql, id)
  if (!saved) throw new Error('memory not saved')
  return saved
}

export function getMemory(sql: Sql, id: string): Memory | null {
  const row = sql.exec<MemoryRow>('SELECT * FROM memories WHERE id = ?', id).toArray()[0]
  return row ? toMemory(row) : null
}

/** Newest first, optionally of one kind. */
export function listMemories(sql: Sql, kind?: MemoryKind): Memory[] {
  const rows = kind
    ? sql.exec<MemoryRow>('SELECT * FROM memories WHERE kind = ? ORDER BY updated_at DESC, id', kind).toArray()
    : sql.exec<MemoryRow>('SELECT * FROM memories ORDER BY updated_at DESC, id').toArray()
  return rows.map(toMemory)
}

export function fileKeyOf(sql: Sql, id: string): string | null {
  return sql.exec<{ file_key: string | null }>('SELECT file_key FROM memories WHERE id = ?', id).toArray()[0]?.file_key ?? null
}

export function updateMemoryRow(
  sql: Sql,
  id: string,
  patch: { title?: string; text?: string; url?: string },
  now = Date.now()
): Memory | null {
  const current = getMemory(sql, id)
  if (!current) return null
  sql.exec(
    'UPDATE memories SET title = ?, text = ?, url = ?, indexed = 0, updated_at = ? WHERE id = ?',
    patch.title ?? current.title,
    patch.text ?? current.text,
    patch.url ?? current.url,
    now,
    id
  )
  return getMemory(sql, id)
}

export function setIndexed(sql: Sql, id: string, indexed: boolean): void {
  sql.exec('UPDATE memories SET indexed = ? WHERE id = ?', indexed ? 1 : 0, id)
}

export function deleteMemoryRow(sql: Sql, id: string): boolean {
  const existed = getMemory(sql, id) !== null
  sql.exec('DELETE FROM memories WHERE id = ?', id)
  return existed
}

export function memoryUsage(sql: Sql): MemoryUsage {
  const row = sql
    .exec<{ count: number; bytes: number | null }>('SELECT COUNT(*) AS count, SUM(file_size) AS bytes FROM memories')
    .toArray()[0]
  return {
    count: row?.count ?? 0,
    limit: MEMORY_LIMITS.count,
    bytes: row?.bytes ?? 0,
    byteLimit: MEMORY_LIMITS.fileBytes,
  }
}

/** A memory of this kind with the same text (ignoring case and spacing), the cheapest duplicate check. */
export function findSameText(sql: Sql, kind: MemoryKind, text: string): Memory | null {
  const wanted = normalize(text)
  return listMemories(sql, kind).find((memory) => normalize(memory.text) === wanted) ?? null
}

/** Memories that couldn't be embedded when saved (no key, a busy model), oldest first. */
export function unindexed(sql: Sql, limit: number): Memory[] {
  return sql
    .exec<MemoryRow>('SELECT * FROM memories WHERE indexed = 0 ORDER BY updated_at LIMIT ?', limit)
    .toArray()
    .map(toMemory)
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
}
