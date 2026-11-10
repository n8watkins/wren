import { GeminiError, connectLive, embedText, generateText, searchWithGoogle, type LiveEvents } from './gemini'
import type { Sql } from './sql'
import { TavilyError, tavilySearch } from './web-search'
import { EMBEDDING_DIMENSIONS } from '../lib/memory'
import { log } from '../lib/log'
import { optionalSetting } from '../lib/secrets'
import {
  MODEL_CHECK_INSTANCE,
  type ModelCheckName,
  type ModelCheckRun,
  type ModelCheckState,
  type ProbeResult,
} from '../lib/model-check'

/**
 * The daily model check (lib/model-check.ts), run only by the Worker's
 * scheduled handler (worker/index.ts): one tiny real call to each model and
 * search service, each with a short timeout, on the demo key and Worker
 * secrets. It counts against no person's or guest's meter, because it is
 * nobody's request, and no route can start it. Nothing upstream sends is
 * kept or logged beyond a short error code and a status.
 */

/** How long each call may take before it counts as failed. */
const PROBE_MS = 20_000

/** A failure the check itself noticed, with its own code. */
class ProbeFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ProbeFailure'
  }
}

export interface Probe {
  name: ModelCheckName
  target: string
  /** Set when the probe can't run (its key isn't set): recorded as not checked. */
  skip?: string
  run(signal: AbortSignal): Promise<void>
}

const NO_EVENTS: LiveEvents = {
  audio: () => undefined,
  inputText: () => undefined,
  outputText: () => undefined,
  interrupted: () => undefined,
  turnComplete: () => undefined,
  goAway: () => undefined,
  closed: () => undefined,
}

/** The probes for this Worker's settings, smallest request each. */
export function probesFor(env: CloudflareEnv): Probe[] {
  const apiKey = optionalSetting(env, 'GEMINI_API_KEY')
  const baseUrl = optionalSetting(env, 'GEMINI_BASE_URL')
  const tavilyKey = optionalSetting(env, 'TAVILY_API_KEY')
  const gemini = { apiKey: apiKey ?? '', keySource: 'demo' as const, baseUrl }
  const noGeminiKey = apiKey ? undefined : 'no_demo_key'

  const chat = (name: ModelCheckName, model: string): Probe => ({
    name,
    target: model,
    skip: noGeminiKey,
    run: async (signal) => {
      const text = await generateText({
        ...gemini,
        model,
        systemPrompt: 'Reply with exactly one word.',
        parts: [{ text: 'Say ok.' }],
        signal,
        timeoutMs: PROBE_MS,
      })
      if (!text.trim()) throw new ProbeFailure('empty_reply')
    },
  })

  const probes: Probe[] = [chat('chat', env.GEMINI_MODEL)]
  const fallback = env.GEMINI_FALLBACK_MODEL?.trim()
  if (fallback && fallback !== env.GEMINI_MODEL) probes.push(chat('chatFallback', fallback))
  probes.push(
    {
      name: 'embedding',
      target: env.GEMINI_EMBEDDING_MODEL,
      skip: noGeminiKey,
      // embedText fails unless the vector has exactly EMBEDDING_DIMENSIONS (768) values.
      run: async () => {
        await embedText({ ...gemini, model: env.GEMINI_EMBEDDING_MODEL, text: 'Wren daily check', dimensions: EMBEDDING_DIMENSIONS, timeoutMs: PROBE_MS })
      },
    },
    {
      name: 'live',
      target: env.GEMINI_LIVE_MODEL,
      skip: noGeminiKey,
      // Opens the Live socket, waits for setupComplete, closes. No audio is sent.
      run: async () => {
        const session = await connectLive(
          { ...gemini, model: env.GEMINI_LIVE_MODEL, systemPrompt: 'Daily check.', history: [], setupMs: PROBE_MS },
          NO_EVENTS
        )
        session.close()
      },
    },
    {
      name: 'googleSearch',
      target: env.GEMINI_MODEL,
      skip: noGeminiKey,
      run: async (signal) => {
        const pages = await searchWithGoogle({ ...gemini, model: env.GEMINI_MODEL, query: 'Cloudflare Workers news this week', signal, timeoutMs: PROBE_MS })
        if (!pages.length) throw new ProbeFailure('no_sources')
      },
    },
    {
      name: 'tavily',
      target: 'tavily',
      skip: tavilyKey ? undefined : 'no_tavily_key',
      run: async (signal) => {
        const results = await tavilySearch('Cloudflare Workers', {
          apiKey: tavilyKey ?? '',
          baseUrl: optionalSetting(env, 'TAVILY_BASE_URL'),
          signal,
          maxResults: 1,
          pageText: false,
        })
        if (!results.length) throw new ProbeFailure('no_results')
      },
    }
  )
  return probes
}

function failure(error: unknown): Pick<ProbeResult, 'code' | 'status'> {
  if (error instanceof ProbeFailure) return { code: error.code }
  if (error instanceof GeminiError) return { code: error.code, status: error.upstreamStatus }
  if (error instanceof TavilyError) return { code: error.status ? 'tavily_error' : 'tavily_unreachable', status: error.status }
  return { code: 'error' }
}

async function runProbe(probe: Probe, timeoutMs: number): Promise<ProbeResult> {
  if (probe.skip) return { target: probe.target, ok: null, ms: 0, code: probe.skip }
  const controller = new AbortController()
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ProbeFailure('timeout'))
    }, timeoutMs)
  })
  const work = probe.run(controller.signal)
  // A probe that loses the race still settles later; that result is dropped.
  work.catch(() => undefined)
  try {
    await Promise.race([work, timedOut])
    return { target: probe.target, ok: true, ms: Date.now() - started }
  } catch (error) {
    return { target: probe.target, ok: false, ms: Date.now() - started, ...failure(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Runs every probe at once; one that takes longer than `timeoutMs` fails as "timeout". */
export async function runProbes(probes: Probe[], options: { timeoutMs?: number; now?: () => number } = {}): Promise<ModelCheckRun> {
  const ranAt = (options.now ?? Date.now)()
  const timeoutMs = options.timeoutMs ?? PROBE_MS + 5_000
  const results = await Promise.all(probes.map(async (probe) => [probe.name, await runProbe(probe, timeoutMs)] as const))
  return { ranAt, results: Object.fromEntries(results) }
}

/** The scheduled handler's work: run the probes, save the result for /api/health, log codes only. */
export async function runModelCheck(env: CloudflareEnv): Promise<ModelCheckRun> {
  const run = await runProbes(probesFor(env))
  await env.MODEL_CHECK.getByName(MODEL_CHECK_INSTANCE).save(run)
  const results = Object.values(run.results)
  for (const result of results) {
    if (result.ok === false) log.warn('model_check.failed', { model: result.target, code: result.code, upstreamStatus: result.status, ms: result.ms })
  }
  log.info('model_check.done', { count: results.filter((r) => r.ok === false).length, ms: Date.now() - run.ranAt })
  return run
}

/*
 * The saved result, in the ModelCheck Durable Object's SQLite
 * (agent/model-check-store.ts): one row per key, JSON values.
 */

export function createModelCheckTable(sql: Sql): void {
  sql.exec('CREATE TABLE IF NOT EXISTS model_check (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
}

export function saveModelCheck(sql: Sql, run: ModelCheckRun): void {
  sql.exec('INSERT INTO model_check (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', 'last_run', JSON.stringify(run))
}

/** The last run, if any; the first read with none saved starts the "not run yet" window. */
export function readModelCheck(sql: Sql, now: number): ModelCheckState {
  const rows = sql.exec<{ key: string; value: string }>('SELECT key, value FROM model_check').toArray()
  const value = (key: string) => rows.find((row) => row.key === key)?.value
  const lastRun = value('last_run')
  let waitingSince = Number(value('waiting_since'))
  if (!lastRun && !Number.isFinite(waitingSince)) {
    waitingSince = now
    sql.exec('INSERT INTO model_check (key, value) VALUES (?, ?)', 'waiting_since', String(now))
  }
  return { lastRun: lastRun ? (JSON.parse(lastRun) as ModelCheckRun) : undefined, waitingSince: Number.isFinite(waitingSince) ? waitingSince : now }
}
