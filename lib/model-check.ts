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
  return `${LABELS[name]} (${result.target}) ${result.status ? `${code} ${result.status}` : code}`
}

/**
 * The backup-only paths and what covers for them while they're down: the
 * fallback chat model (the primary answers chat) and Google Search grounding
 * (Tavily searches for research). A backup's failure is a warning while its
 * primary works, and a failure when the primary is down or unchecked too.
 */
const BACKUPS: Partial<Record<ModelCheckName, { primary: ModelCheckName; covered: (primary: ProbeResult) => string }>> = {
  chatFallback: { primary: 'chat', covered: (primary) => `chat uses ${primary.target}` },
  googleSearch: { primary: 'tavily', covered: () => 'research uses Tavily' },
}

export interface ModelsHealth {
  ok: boolean | null
  detail: string
  /** A backup-only path isn't working while its primary is: shown, but the status stays "ok". */
  warning?: true
}

/**
 * Health's "models" check from the saved state. Not ok (status "degraded")
 * when a primary dependency failed, when a backup failed with its primary
 * down too, or when the last run is stale or no run has been saved for a
 * whole freshness window; a warning, still ok, when only a backup failed;
 * null (not run yet) only in the first window after a deploy, so a new
 * deploy doesn't page.
 */
export function modelsHealth(state: ModelCheckState, now: number): ModelsHealth {
  const run = state.lastRun
  if (!run) {
    const waited = now - state.waitingSince
    if (waited <= MODEL_CHECK_FRESH_MS) return { ok: null, detail: 'the daily model check has not run yet' }
    return { ok: false, detail: `no daily model check has run since ${ago(waited)}` }
  }
  const age = now - run.ranAt
  if (age > MODEL_CHECK_FRESH_MS) return { ok: false, detail: `the last daily model check is stale (${ago(age)})` }
  const entries = MODEL_CHECKS.flatMap((name) => (run.results[name] ? [[name, run.results[name]] as const] : []))
  const failures: string[] = []
  const backups: string[] = []
  for (const [name, result] of entries) {
    if (result.ok !== false) continue
    const backup = BACKUPS[name]
    const primary = backup && run.results[backup.primary]
    if (backup && primary?.ok === true) backups.push(`${failureText(name, result)} (${backup.covered(primary)})`)
    else failures.push(failureText(name, result))
  }
  const answered = entries.filter(([, result]) => result.ok === true).length
  const skipped = entries.filter(([, result]) => result.ok === null).map(([name]) => LABELS[name])
  if (!answered && !failures.length) return { ok: null, detail: 'the daily model check had no keys to check with' }
  const detail = [
    failures.length ? `failed ${ago(age)}: ${failures.join('; ')}` : `${answered} of ${entries.length} answered ${ago(age)}`,
    backups.length ? `backup not working: ${backups.join('; ')}` : '',
    skipped.length ? `not checked (no key): ${skipped.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
  if (failures.length) return { ok: false, detail }
  return backups.length ? { ok: true, detail, warning: true } : { ok: true, detail }
}
