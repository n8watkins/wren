import { describe, expect, it } from 'vitest'
import { canonicalRedirect } from '../../lib/security/canonical'

const PUBLIC = 'https://wren.n8builds.dev'

describe('one public address', () => {
  it('sends the workers.dev address to wren.n8builds.dev, keeping path and query', () => {
    expect(canonicalRedirect('https://wren.nathancwatkins23.workers.dev/chat/abc?x=1', PUBLIC)).toBe(
      'https://wren.n8builds.dev/chat/abc?x=1'
    )
    expect(
      canonicalRedirect('https://wren.nathancwatkins23.workers.dev/api/auth/magic-link/verify?token=t&callbackURL=%2F', PUBLIC)
    ).toBe('https://wren.n8builds.dev/api/auth/magic-link/verify?token=t&callbackURL=%2F')
  })

  it('leaves the public address, local runs and other hosts alone', () => {
    expect(canonicalRedirect('https://wren.n8builds.dev/', PUBLIC)).toBeNull()
    expect(canonicalRedirect('http://localhost:3120/', 'http://localhost:3120')).toBeNull()
    expect(canonicalRedirect('http://127.0.0.2:3121/', 'http://127.0.0.2:3121')).toBeNull()
    expect(canonicalRedirect('https://evil.example/', PUBLIC)).toBeNull()
  })

  it('never redirects to a path that leaves the public host', () => {
    expect(canonicalRedirect('https://wren.x.workers.dev//evil.example/path', PUBLIC)).toBe('https://wren.n8builds.dev//evil.example/path')
    expect(new URL(canonicalRedirect('https://wren.x.workers.dev//evil.example/path', PUBLIC)!).host).toBe('wren.n8builds.dev')
  })
})
