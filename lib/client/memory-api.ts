import type { AutoSave, Memory, MemoryKind, MemoryUsage } from '@/lib/memory'
import type { ErrorCode } from '@/lib/errors'
import { request } from './api'

/** The Memory page's side of the API. The person's own Gemini key, if any, rides along for embeddings. */

export interface MemoryListResponse {
  memories: Memory[]
  usage: MemoryUsage
  meaning: boolean
  notice?: ErrorCode
}

function headers(userKey: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return userKey ? { ...extra, 'X-Gemini-Key': userKey } : extra
}

export const memoryApi = {
  list: (options: { query?: string; kind?: MemoryKind; userKey: string | null; signal?: AbortSignal }) => {
    const params = new URLSearchParams()
    if (options.query) params.set('q', options.query)
    if (options.kind) params.set('kind', options.kind)
    const qs = params.toString()
    return request<MemoryListResponse>(`/api/memory${qs ? `?${qs}` : ''}`, { headers: headers(options.userKey), signal: options.signal })
  },
  addNote: (text: string, userKey: string | null) =>
    request<{ memory: Memory }>('/api/memory', {
      method: 'POST',
      headers: headers(userKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ kind: 'note', text }),
    }).then((r) => r.memory),
  addLink: (url: string, title: string, userKey: string | null) =>
    request<{ memory: Memory }>('/api/memory', {
      method: 'POST',
      headers: headers(userKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ kind: 'link', url, title: title || undefined }),
    }).then((r) => r.memory),
  upload: (file: File, userKey: string | null) =>
    request<{ memory: Memory }>('/api/memory/files', {
      method: 'POST',
      headers: headers(userKey, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }),
      body: file,
    }).then((r) => r.memory),
  update: (id: string, patch: { title?: string; text?: string; url?: string }, userKey: string | null) =>
    request<{ memory: Memory }>(`/api/memory/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: headers(userKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch),
    }).then((r) => r.memory),
  remove: (id: string) => request<{ deleted: boolean }>(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  fileUrl: (id: string) => `/api/memory/${encodeURIComponent(id)}/file`,
  /** "Save to Memory" on a chat message; saving it again returns the same memory. */
  saveMessage: (chatId: string, messageId: string, userKey: string | null) =>
    request<{ memory: Memory }>(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/save`, {
      method: 'POST',
      headers: headers(userKey),
    }).then((r) => r.memory),
  /** Undo a fact Wren saved on its own. */
  undoSave: (chatId: string, saveId: string, userKey: string | null) =>
    request<{ save: AutoSave }>(`/api/chats/${encodeURIComponent(chatId)}/saves/${encodeURIComponent(saveId)}/undo`, {
      method: 'POST',
      headers: headers(userKey),
    }).then((r) => r.save),
}

/** Where a memory is on the Memory page (the page scrolls to it and marks it). */
export function memoryHref(id: string): string {
  return `/memory#m-${id}`
}
