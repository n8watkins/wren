/**
 * The daily model check (agent/model-check.ts): once a day, a Cron Trigger
 * makes one tiny real call to each model and search service Wren depends on
 * and saves the result. /api/health reports the last result without calling
 * anything, so OpenPing can poll it often for free and still learn that a
 * model stopped answering.
 */

/** Each dependency the check calls, in the order health lists them. */
const MODEL_CHECKS = ['chat', 'chatFallback', 'embedding', 'live', 'googleSearch', 'tavily'] as const
export type ModelCheckName = (typeof MODEL_CHECKS)[number]

const LABELS: Record<ModelCheckName, string> = {
  chat: 'chat model',
  chatFallback: 'fallback chat model',
  embedding: 'embeddings',
  live: 'Gemini Live',
  googleSearch: 'Google Search grounding',
  tavily: 'Tavily',
}

export interface ProbeResult {
  /** The model or service called. */
  target: string
  /** null: not called, because its key isn't set (`code` says which). */
  ok: boolean | null
  ms: number
  /** A short error code when it failed or was skipped; never upstream text. */
  code?: string
  /** The upstream HTTP status (or WebSocket close code), when there was one. */
  status?: number
  /** 2 when the first try failed and this is the second (agent/model-check.ts). */
  attempts?: number
}

export interface ModelCheckRun {
  /** When the run started (ms since the epoch). */
  ranAt: number
  results: Partial<Record<ModelCheckName, ProbeResult>>
}

export interface ModelCheckState {
  lastRun?: ModelCheckRun
  /** When health first asked and no run had been saved yet. */
  waitingSince: number
}

/** The single ModelCheck Durable Object instance. */
export const MODEL_CHECK_INSTANCE = 'daily'

/** A run counts for this long: a day, plus slack for a late or slow cron. */
export const MODEL_CHECK_FRESH_MS = 26 * 60 * 60 * 1000

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 90) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}

function failureText(name: ModelCheckName, result: ProbeResult): string {
  const code = result.code ?? 'error'
  return `${LABELS[name]} (${result.target}): ${result.status ? `${code} ${result.status}` : code}`
}

/**
 * Health's "models" check from the saved state. ok when the last run passed
 * and is fresh; not ok when it failed or is stale, or when no run has been
 * saved for a whole freshness window; null (not run yet) only in the first
 * window after a deploy, so a new deploy doesn't page.
 */
export function modelsHealth(state: ModelCheckState, now: number): { ok: boolean | null; detail: string } {
  const run = state.lastRun
  if (!run) {
    const waited = now - state.waitingSince
    if (waited <= MODEL_CHECK_FRESH_MS) return { ok: null, detail: 'the daily model check has not run yet' }
    return { ok: false, detail: `no daily model check has run since ${ago(waited)}` }
  }
  const age = now - run.ranAt
  if (age > MODEL_CHECK_FRESH_MS) return { ok: false, detail: `the last daily model check is stale (${ago(age)})` }
  const entries = MODEL_CHECKS.flatMap((name) => (run.results[name] ? [[name, run.results[name]] as const] : []))
  const failed = entries.filter(([, result]) => result.ok === false)
  if (failed.length) {
    return { ok: false, detail: `failed ${ago(age)}: ${failed.map(([name, result]) => failureText(name, result)).join('; ')}` }
  }
  const answered = entries.filter(([, result]) => result.ok === true).length
  const skipped = entries.filter(([, result]) => result.ok === null).map(([name]) => LABELS[name])
  if (!answered) return { ok: null, detail: 'the daily model check had no keys to check with' }
  return {
    ok: true,
    detail: `${answered} of ${entries.length} answered ${ago(age)}${skipped.length ? `; not checked (no key): ${skipped.join(', ')}` : ''}`,
  }
}
