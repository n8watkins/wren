import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Static checks for the Lessons (docs/LESSONS.md) that lint can't express:
 * every API route is listed here with who may call it, every route that acts
 * for a person goes through authed() (verified session, then burst limits),
 * and nothing that looks like a debug or admin route exists.
 */
const ROOT = join(__dirname, '..', '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const routes = files(join(ROOT, 'app')).filter((f) => /\/route\.tsx?$/.test(f))
const routePath = (file: string) =>
  '/' + relative(join(ROOT, 'app'), file).replace(/\/route\.tsx?$/, '').replace(/\([^)]+\)\//g, '')

/** Every route, and who may call it. A new route fails this test until it is listed. */
const ROUTES: Record<string, 'public' | 'session' | 'guest'> = {
  '/api/auth/[...all]': 'public',
  '/api/health': 'public',
  // Public, but it only answers a valid Turnstile token with a guest cookie.
  '/api/guest/start': 'public',
  '/api/guest/chat': 'guest',
  '/api/guest/usage': 'guest',
  '/api/chat': 'session',
  '/api/chat/stop': 'session',
  '/api/chats': 'session',
  '/api/chats/[id]': 'session',
  '/api/chats/[id]/messages/[messageId]/save': 'session',
  '/api/chats/[id]/saves/[saveId]/undo': 'session',
  '/api/usage': 'session',
  '/api/memory': 'session',
  '/api/memory/files': 'session',
  '/api/memory/[id]': 'session',
  '/api/memory/[id]/file': 'session',
  '/api/runs': 'session',
  '/api/runs/[id]': 'session',
  '/api/runs/[id]/cancel': 'session',
  '/api/runs/[id]/stream': 'session',
  // The voice socket itself (GET /api/voice) is taken by the Worker before Next (worker/voice.ts).
  '/api/voice/ticket': 'session',
}

describe('API routes', () => {
  it('are all listed with who may call them', () => {
    expect(routes.map(routePath).sort()).toEqual(Object.keys(ROUTES).sort())
  })

  it.each(routes.map((f) => [routePath(f), f]))('%s checks the session or guest cookie when it must', (path, file) => {
    const source = readFileSync(file, 'utf8')
    const kind = ROUTES[path]
    if (kind === 'public') return
    const wrapper = kind === 'session' ? 'authed' : 'guestOnly'
    const handlers = source.match(/export const (GET|POST|PUT|PATCH|DELETE)\b/g) ?? []
    const wrapped = source.match(new RegExp(`export const (GET|POST|PUT|PATCH|DELETE)(<[^>]*>)?\\s*=\\s*${wrapper}(<[^>]*>)?\\(`, 'g')) ?? []
    expect(handlers.length).toBeGreaterThan(0)
    expect(wrapped.length).toBe(handlers.length)
    expect(source).not.toMatch(/export (async )?function (GET|POST|PUT|PATCH|DELETE)/)
  })

  it('guest routes never read the session, and session routes never read the guest cookie', () => {
    for (const file of routes) {
      const source = readFileSync(file, 'utf8')
      if (ROUTES[routePath(file)] === 'guest') expect(source).not.toMatch(/getVerifiedSession|agentFor\(/)
      if (ROUTES[routePath(file)] === 'session') expect(source).not.toMatch(/readGuest|guestAgentFor/)
    }
  })

  it('include nothing that looks like a debug, admin, log or test route', () => {
    for (const path of routes.map(routePath)) {
      expect(path).not.toMatch(/debug|admin|logs?\b|test|internal|dump|seed|reset/i)
    }
  })
})

describe('source rules', () => {
  const source = files(ROOT)
    .filter((f) => /\.(ts|tsx|mjs)$/.test(f))
    .filter((f) => !/node_modules|\.next|\.open-next|\.wrangler|cloudflare-env\.d\.ts|tests\//.test(f))

  it('only agent/gemini.ts imports the Gemini SDK', () => {
    const importers = source.filter((f) => /from ['"]@google\/genai['"]/.test(readFileSync(f, 'utf8')))
    expect(importers.map((f) => relative(ROOT, f))).toEqual(['agent/gemini.ts'])
  })

  it('only agent/gemini.ts reaches the Gemini API, Live included', () => {
    const callers = source.filter((f) => /generativelanguage\.googleapis\.com|BidiGenerateContent/.test(readFileSync(f, 'utf8')))
    expect(callers.map((f) => relative(ROOT, f))).toEqual(['agent/gemini.ts'])
  })

  it('no request handler reads a user id from what the client sent', () => {
    for (const file of source.filter((f) => f.includes('/app/'))) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/(body|query|searchParams|params|headers)\??\.(get\(['"])?user[-_]?id/i)
    }
  })

  it('agent stores take no user id: the Durable Object instance is the person', () => {
    for (const file of ['agent/chats.ts', 'agent/meter.ts', 'agent/memory-store.ts', 'agent/memory.ts', 'agent/memory-vectors.ts', 'agent/research-store.ts', 'agent/research.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(/user_?id/i)
    }
  })
})
