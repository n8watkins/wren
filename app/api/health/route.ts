import { getEnv, isProduction } from '@/lib/server/env'
import { signInMethods } from '@/lib/server/auth'
import { optionalSetting } from '@/lib/secrets'
import { jsonResponse } from '@/lib/server/http'
import { guestChatConfigured } from '@/lib/server/turnstile'
import { DAILY_LIMITS } from '@/lib/limits'
import { MODEL_CHECK_INSTANCE, modelsHealth } from '@/lib/model-check'

/**
 * One check per feature, for OpenPing and for a person reading it. It says
 * what works, never a secret. 503 when something core is down or the
 * production configuration is unsafe; "degraded" when a feature is waiting on
 * a setting (a key the owner hasn't added yet) or the daily model check
 * (lib/model-check.ts) found a model or search service not answering. Health
 * itself never calls a model: it reads that check's saved result.
 */

// warning: something is off but a backup covers it, so the status stays "ok" (the daily model check).
type Check = { ok: boolean | null; detail: string; warning?: true }

async function timed<T>(work: () => Promise<T>): Promise<{ value?: T; error?: true; ms: number }> {
  const started = Date.now()
  try {
    return { value: await work(), ms: Date.now() - started }
  } catch {
    return { error: true, ms: Date.now() - started }
  }
}

/** Memory needs its R2 bucket and its search index (or local vectors in test runs); meaning search needs a key. */
function memoryCheck(env: CloudflareEnv, demoKey: boolean): Check {
  const localVectors = optionalSetting(env, 'MEMORY_VECTORS') === 'local'
  const bound = Boolean(env.MEMORY_FILES) && (localVectors || Boolean(env.MEMORY_INDEX))
  if (!bound) return { ok: false, detail: 'the memory bucket or search index is not bound' }
  const vectors = localVectors ? 'local vectors' : 'Vectorize'
  return {
    ok: true,
    detail: demoKey
      ? `notes, links, files and facts from chat, searched by meaning and recalled in chat (${env.GEMINI_EMBEDDING_MODEL}, ${vectors})`
      : `notes, links and files; search by meaning and recall in chat need a Gemini key (${vectors})`,
  }
}

/** Voice needs its Live model configured; the demo key makes it work for everyone (no model call here). */
function voiceCheck(env: CloudflareEnv, demoKey: boolean): Check {
  const model = env.GEMINI_LIVE_MODEL?.trim()
  if (!model) return { ok: false, detail: 'no Gemini Live model configured (GEMINI_LIVE_MODEL)' }
  return {
    ok: demoKey,
    detail: demoKey
      ? `${model} through each person's agent, ${DAILY_LIMITS.voiceMinutes} minutes a day on the demo key`
      : `${model}: no demo key yet, voice works with your own Gemini key`,
  }
}

export async function GET(): Promise<Response> {
  const env = getEnv()
  const production = isProduction(env) && new URL(env.PUBLIC_URL).protocol === 'https:'

  const [database, agents, modelCheck] = await Promise.all([
    timed(() => env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()),
    timed(() => env.DAILY_COUNTER.getByName('health').ping()),
    timed(() => env.MODEL_CHECK.getByName(MODEL_CHECK_INSTANCE).state()),
  ])
  const testHooks =
    env.EMAIL_TRANSPORT === 'outbox' ||
    optionalSetting(env, 'GEMINI_BASE_URL') !== undefined ||
    optionalSetting(env, 'TURNSTILE_VERIFY_URL') !== undefined ||
    optionalSetting(env, 'MEMORY_VECTORS') !== undefined ||
    optionalSetting(env, 'TAVILY_BASE_URL') !== undefined
  const guests = guestChatConfigured(env)
  const demoKey = optionalSetting(env, 'GEMINI_API_KEY') !== undefined
  const methods = signInMethods(env)
  const tavily = optionalSetting(env, 'TAVILY_API_KEY') !== undefined

  const checks: Record<string, Check> = {
    database: { ok: database.value?.ok === 1, detail: `D1 answered in ${database.ms} ms` },
    agents: { ok: agents.value === true, detail: `Durable Objects answered in ${agents.ms} ms` },
    config: {
      ok: !(production && testHooks),
      detail: testHooks ? 'test settings are on (local runs only)' : 'production settings',
    },
    chat: {
      ok: demoKey,
      detail: demoKey ? `${env.GEMINI_MODEL} on the demo key${env.GEMINI_FALLBACK_MODEL ? `, falling back to ${env.GEMINI_FALLBACK_MODEL}` : ''}` : 'no demo key yet: chat works with your own Gemini key',
    },
    guestChat: {
      ok: guests,
      detail: guests ? `guests get 5 messages a day, ${env.GUEST_SITE_DAILY_CAP} site-wide` : 'Turnstile keys not set: guests must sign in',
    },
    signInEmail: { ok: methods.email, detail: `sign-in links by ${env.EMAIL_TRANSPORT === 'outbox' ? 'local outbox' : 'Cloudflare Email Service'}` },
    signInGithub: { ok: methods.github, detail: methods.github ? 'GitHub sign-in is set up' : 'GitHub OAuth app not set up yet' },
    voice: voiceCheck(env, demoKey),
    research: {
      ok: demoKey,
      detail: !demoKey
        ? 'needs the demo key'
        : tavily
          ? 'searches with Tavily, Gemini Google Search as the backup'
          : 'no Tavily key yet: searches with Gemini Google Search',
    },
    memory: memoryCheck(env, demoKey),
    models: modelCheck.value
      ? modelsHealth(modelCheck.value, Date.now())
      : { ok: false, detail: "couldn't read the daily model check's last result" },
  }

  const core = checks.database.ok && checks.agents.ok && checks.config.ok
  const degraded = Object.values(checks).some((check) => check.ok === false)
  const status = !core ? 'down' : degraded ? 'degraded' : 'ok'
  // Each dependency's last real call: ok, how long it took, and a short error code.
  const lastRun = modelCheck.value?.lastRun
  const models = lastRun ? { ranAt: new Date(lastRun.ranAt).toISOString(), results: lastRun.results } : null
  return jsonResponse({ status, checks, models }, { status: core ? 200 : 503 })
}
