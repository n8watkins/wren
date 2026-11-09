import type { ReactNode } from 'react'
import { headers } from 'next/headers'
import { WrenApp } from '@/components/app/WrenApp'
import type { ChatSummary } from '@/agent/chats'
import type { UsageSnapshot } from '@/lib/limits'
import { agentFor } from '@/lib/server/agent'
import { signInMethods } from '@/lib/server/auth'
import { getEnv } from '@/lib/server/env'
import { getVerifiedSession } from '@/lib/server/session'
import { log } from '@/lib/log'

/**
 * Every app route shares this shell. The server works out who is signed in
 * (from the session cookie, checked against D1) and hands the client their
 * chats and today's usage; the routes themselves render nothing extra.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const env = getEnv()
  const session = await getVerifiedSession(env, await headers())
  let chats: ChatSummary[] = []
  let usage: UsageSnapshot | null = null
  if (session) {
    try {
      const agent = await agentFor(env, session.userId)
      ;[chats, usage] = await Promise.all([agent.listChats(), agent.usage()])
    } catch (error) {
      // `next dev` has no Durable Objects (use `npm run preview`); the client
      // loads them again through the API.
      log.warn('layout.agent_unavailable', { code: error instanceof Error ? error.name : 'unknown' })
    }
  }
  return (
    <>
      <WrenApp
        person={session ? { name: session.name, email: session.email } : null}
        github={signInMethods(env).github}
        initialChats={chats}
        initialUsage={usage}
      />
      {children}
    </>
  )
}
