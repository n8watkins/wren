import { describe, expect, it } from 'vitest'
import { memoryListQuery, memoryPatch, newMemory } from '../../lib/server/memory-schemas'
import { MEMORY_LIMITS, fileTypeFor, formatBytes } from '../../lib/memory'

describe('memory request schemas', () => {
  it('accept a note and an http(s) link', () => {
    expect(newMemory.parse({ kind: 'note', text: '  Buy arborio  ' })).toEqual({ kind: 'note', text: 'Buy arborio' })
    expect(newMemory.parse({ kind: 'link', url: 'https://Example.com/a b' })).toEqual({ kind: 'link', url: 'https://example.com/a%20b' })
  })

  it('reject other kinds, extra fields and unsafe links', () => {
    for (const body of [
      { kind: 'fact', text: 'Wren saves facts, not the API' },
      { kind: 'file', text: 'files come through the upload' },
      { kind: 'note', text: 'x', userId: 'someone-else' },
      { kind: 'note', text: 'x', origin: 'wren' },
      { kind: 'note', text: '   ' },
      { kind: 'note', text: 'x'.repeat(MEMORY_LIMITS.noteChars + 1) },
      { kind: 'link', url: 'javascript:alert(1)' },
      { kind: 'link', url: 'data:text/html,hi' },
      { kind: 'link', url: 'file:///etc/passwd' },
      { kind: 'link', url: 'https://user:pass@example.com/' },
      { kind: 'link', url: 'not a url' },
      { kind: 'link', url: `https://example.com/${'x'.repeat(MEMORY_LIMITS.urlChars)}` },
    ]) {
      expect(newMemory.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(false)
    }
  })

  it('need something to change in an edit, and nothing else', () => {
    expect(memoryPatch.safeParse({}).success).toBe(false)
    expect(memoryPatch.safeParse({ text: 'x', kind: 'note' }).success).toBe(false)
    expect(memoryPatch.parse({ title: ' T ' })).toEqual({ title: 'T' })
  })

  it('take a search and a kind only', () => {
    expect(memoryListQuery.parse({ q: ' heat ', kind: 'note' })).toEqual({ q: 'heat', kind: 'note' })
    expect(memoryListQuery.safeParse({ kind: 'secret' }).success).toBe(false)
    expect(memoryListQuery.safeParse({ q: 'x'.repeat(MEMORY_LIMITS.queryChars + 1) }).success).toBe(false)
  })
})

describe('memory helpers', () => {
  it('know the file types by extension', () => {
    expect(fileTypeFor('Plan.MD')).toBe('text/markdown')
    expect(fileTypeFor('a.pdf')).toBe('application/pdf')
    expect(fileTypeFor('a.txt')).toBe('text/plain')
    expect(fileTypeFor('a.html')).toBeNull()
    expect(fileTypeFor('pdf')).toBeNull()
  })

  it('format sizes', () => {
    expect(formatBytes(1)).toBe('1 byte')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB')
  })
})
