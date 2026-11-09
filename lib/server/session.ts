import 'server-only'
import { createAuth } from './auth'

export interface VerifiedSession {
  /** From the session row in D1, looked up by the signed session cookie. */
  userId: string
  name: string
  email: string
}

/**
 * The person behind this request, or null. Identity only ever comes from here:
 * no route reads a user id from the body, the query or a header
 * (tests/unit/lessons.test.ts checks every route).
 */
export async function getVerifiedSession(env: CloudflareEnv, headers: Headers): Promise<VerifiedSession | null> {
  const session = await createAuth(env).api.getSession({ headers })
  if (!session) return null
  return { userId: session.user.id, name: session.user.name, email: session.user.email }
}
