import 'server-only'
import { getAgentByName } from 'agents/routing'

/**
 * The signed-in person's own agent. The name is the verified user id from the
 * session (lib/server/session.ts) and nothing else: no request field can
 * choose whose agent this is.
 */
export function agentFor(env: CloudflareEnv, verifiedUserId: string) {
  return getAgentByName(env.WREN_AGENT, verifiedUserId)
}

/**
 * A guest's agent, named from the id in their signed guest cookie
 * (lib/server/guest.ts). The `guest:` prefix keeps it apart from people's
 * agents: Better Auth's user ids never contain a colon.
 */
export function guestAgentFor(env: CloudflareEnv, verifiedGuestId: string) {
  return getAgentByName(env.WREN_AGENT, `guest:${verifiedGuestId}`)
}
