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
