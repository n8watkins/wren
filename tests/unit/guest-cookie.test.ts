import { describe, expect, it } from 'vitest'
import { signGuest, verifyGuest } from '../../lib/server/guest'

const SECRET = 'unit-test-secret-0123456789abcdef'
const ID = '3f0c7a52-9a1e-4c8e-8f43-2b7d1e6a9c10'

describe('guest cookie', () => {
  it('verifies its own signature until it expires', async () => {
    const expires = Date.now() + 60_000
    const value = await signGuest(SECRET, ID, expires)
    expect(await verifyGuest(SECRET, value)).toBe(ID)
    expect(await verifyGuest(SECRET, value, expires + 1)).toBeNull()
  })

  it('rejects another id, a later expiry or another secret', async () => {
    const expires = Date.now() + 60_000
    const [, , signature] = (await signGuest(SECRET, ID, expires)).split('.')
    expect(await verifyGuest(SECRET, `${crypto.randomUUID()}.${expires}.${signature}`)).toBeNull()
    expect(await verifyGuest(SECRET, `${ID}.${expires + 86_400_000}.${signature}`)).toBeNull()
    expect(await verifyGuest('another-secret-0123456789abcdef', await signGuest(SECRET, ID, expires))).toBeNull()
  })

  it('rejects malformed values', async () => {
    for (const value of ['', 'abc', `${ID}.soon.sig`, `${ID}.123.`, `not-a-uuid.${Date.now() + 1000}.sig`, 'a.b.c.d']) {
      expect(await verifyGuest(SECRET, value)).toBeNull()
    }
  })
})
