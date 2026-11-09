import type { Sql } from './sql'
import { SIZE_LIMITS } from '../lib/limits'

/**
 * One person's chats, in their own agent's SQLite database. Nothing here takes
 * a user id: the Durable Object instance is the person, so another person's
 * chats are not reachable from this code at all.
 */

export type Role = 'user' | 'model'
export type MessageStatus = 'done' | 'stopped' | 'error'

export interface ChatSummary {
  id: string
  title: string
  updatedAt: number
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  status: MessageStatus
  createdAt: number
}

type ChatRow = { id: string; title: string; updated_at: number }
type MessageRow = { id: string; role: string; content: string; status: string; created_at: number }

export function createChatTables(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('done', 'stopped', 'error')),
    created_at INTEGER NOT NULL
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (chat_id, seq)')
}

function newId(): string {
  return crypto.randomUUID()
}

/** A chat's title: its first message on one line, shortened at a word. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= SIZE_LIMITS.titleChars) return line || 'New chat'
  const cut = line.slice(0, SIZE_LIMITS.titleChars - 1)
  const atWord = cut.lastIndexOf(' ')
  return `${(atWord > 40 ? cut.slice(0, atWord) : cut).trimEnd()}…`
}

export function listChats(sql: Sql, limit = 100): ChatSummary[] {
  return sql
    .exec<ChatRow>('SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC LIMIT ?', limit)
    .toArray()
    .map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }))
}

export function getChat(sql: Sql, id: string): ChatSummary | null {
  const row = sql.exec<ChatRow>('SELECT id, title, updated_at FROM chats WHERE id = ?', id).toArray()[0]
  return row ? { id: row.id, title: row.title, updatedAt: row.updated_at } : null
}

export function createChat(sql: Sql, title: string, now = Date.now()): ChatSummary {
  const id = newId()
  sql.exec('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', id, title, now, now)
  // Keep the newest chats only.
  sql.exec(
    `DELETE FROM chats WHERE id IN (
      SELECT id FROM chats ORDER BY updated_at DESC LIMIT -1 OFFSET ?
    )`,
    SIZE_LIMITS.chatsPerPerson
  )
  return { id, title, updatedAt: now }
}

export function deleteChat(sql: Sql, id: string): boolean {
  sql.exec('DELETE FROM messages WHERE chat_id = ?', id)
  const before = getChat(sql, id)
  sql.exec('DELETE FROM chats WHERE id = ?', id)
  return before !== null
}

export function listMessages(sql: Sql, chatId: string): ChatMessage[] {
  return sql
    .exec<MessageRow>(
      'SELECT id, role, content, status, created_at FROM messages WHERE chat_id = ? ORDER BY seq',
      chatId
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      role: row.role as Role,
      content: row.content,
      status: row.status as MessageStatus,
      createdAt: row.created_at,
    }))
}

export function addMessage(
  sql: Sql,
  chatId: string,
  role: Role,
  content: string,
  status: MessageStatus = 'done',
  now = Date.now()
): ChatMessage {
  const id = newId()
  sql.exec(
    'INSERT INTO messages (id, chat_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    chatId,
    role,
    content,
    status,
    now
  )
  sql.exec('UPDATE chats SET updated_at = ? WHERE id = ?', now, chatId)
  sql.exec(
    `DELETE FROM messages WHERE chat_id = ? AND seq IN (
      SELECT seq FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT -1 OFFSET ?
    )`,
    chatId,
    chatId,
    SIZE_LIMITS.messagesPerChat
  )
  return { id, role, content, status, createdAt: now }
}

export function updateMessage(sql: Sql, id: string, content: string, status: MessageStatus): void {
  sql.exec('UPDATE messages SET content = ?, status = ? WHERE id = ?', content, status, id)
}

/**
 * Regenerate: drops the chat's trailing model answer and returns the user
 * message it answered, or null when the chat doesn't end in a user turn.
 */
export function dropLastAnswer(sql: Sql, chatId: string): ChatMessage | null {
  const messages = listMessages(sql, chatId)
  const last = messages.at(-1)
  if (last?.role === 'model') {
    sql.exec('DELETE FROM messages WHERE id = ?', last.id)
    messages.pop()
  }
  const prompt = messages.at(-1)
  return prompt?.role === 'user' ? prompt : null
}

/**
 * The conversation sent to the model: the newest turns that fit in
 * SIZE_LIMITS.historyChars, oldest first, always starting with a user turn.
 */
export function historyForModel(messages: ChatMessage[]): { role: Role; text: string }[] {
  const picked: { role: Role; text: string }[] = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message.content) continue
    if (total + message.content.length > SIZE_LIMITS.historyChars && picked.length > 0) break
    total += message.content.length
    picked.unshift({ role: message.role, text: message.content })
  }
  while (picked.length > 0 && picked[0].role !== 'user') picked.shift()
  return picked
}
