import { getEnv, isProduction } from '@/lib/server/env'
import { signInMethods } from '@/lib/server/auth'
import { optionalSetting } from '@/lib/secrets'
import { jsonResponse } from '@/lib/server/http'
import { guestChatConfigured } from '@/lib/server/turnstile'

/**
 * One check per feature, for OpenPing and for a person reading it. It says
 * what works, never a secret. 503 when something core is down or the
 * production configuration is unsafe; "degraded" when a feature is waiting on
 * a setting (a key the owner hasn't added yet).
 */

type Check = { ok: boolean | null; detail: string }

async function timed<T>(work: () => Promise<T>): Promise<{ value?: T; error?: true; ms: number }> {
  const started = Date.now()
  try {
    return { value: await work(), ms: Date.now() - started }
  } catch {
    return { error: true, ms: Date.now() - started }
  }
}

export async function GET(): Promise<Response> {
  const env = getEnv()
  const production = isProduction(env) && new URL(env.PUBLIC_URL).protocol === 'https:'

  const database = await timed(() => env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>())
  const agents = await timed(() => env.DAILY_COUNTER.getByName('health').ping())
  const testHooks =
    env.EMAIL_TRANSPORT === 'outbox' ||
    optionalSetting(env, 'GEMINI_BASE_URL') !== undefined ||
    optionalSetting(env, 'TURNSTILE_VERIFY_URL') !== undefined
  const guests = guestChatConfigured(env)
  const demoKey = optionalSetting(env, 'GEMINI_API_KEY') !== undefined
  const methods = signInMethods(env)

  const checks: Record<string, Check> = {
    database: { ok: database.value?.ok === 1, detail: `D1 answered in ${database.ms} ms` },
    agents: { ok: agents.value === true, detail: `Durable Objects answered in ${agents.ms} ms` },
    config: {
      ok: !(production && testHooks),
      detail: testHooks ? 'test settings are on (local runs only)' : 'production settings',
    },
    chat: {
      ok: demoKey,
      detail: demoKey ? `${env.GEMINI_MODEL} on the demo key` : 'no demo key yet: chat works with your own Gemini key',
    },
    guestChat: {
      ok: guests,
      detail: guests ? `guests get 5 messages a day, ${env.GUEST_SITE_DAILY_CAP} site-wide` : 'Turnstile keys not set: guests must sign in',
    },
    signInEmail: { ok: methods.email, detail: `sign-in links by ${env.EMAIL_TRANSPORT === 'outbox' ? 'local outbox' : 'Cloudflare Email Service'}` },
    signInGithub: { ok: methods.github, detail: methods.github ? 'GitHub sign-in is set up' : 'GitHub OAuth app not set up yet' },
    voice: { ok: null, detail: 'coming in the next update' },
    research: { ok: null, detail: 'coming in a later update' },
    memory: { ok: null, detail: 'coming in a later update' },
  }

  const core = checks.database.ok && checks.agents.ok && checks.config.ok
  const degraded = Object.values(checks).some((check) => check.ok === false)
  const status = !core ? 'down' : degraded ? 'degraded' : 'ok'
  return jsonResponse({ status, checks }, { status: core ? 200 : 503 })
}
