import { createAuthClient } from 'better-auth/react'
import { magicLinkClient } from 'better-auth/client/plugins'

/** Better Auth's browser client, same origin (/api/auth). */
export const authClient = createAuthClient({ plugins: [magicLinkClient()] })
