/**
 * What a research run looks like to the API and the Runs page. The run itself
 * lives in the person's own agent (agent/research.ts); this module holds only
 * the shapes and the words, so the browser can import it.
 */

export type RunStatus = 'planning' | 'searching' | 'reading' | 'writing' | 'done' | 'failed' | 'cancelled'

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(['planning', 'searching', 'reading', 'writing'])

export function isActive(status: RunStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

/** Why a run ended without a report. The person's daily run is given back for all of them. */
export type RunFailure = 'no_results' | 'no_sources' | 'model_busy' | 'model_unavailable' | 'model_error' | 'stalled' | 'internal'

export const RUN_FAILURES: Record<RunFailure, string> = {
  no_results: 'None of the searches found anything to read.',
  no_sources: 'None of the pages it found could be read.',
  model_busy: 'Gemini is busy right now.',
  model_unavailable: 'Gemini isn’t available right now.',
  model_error: 'Gemini didn’t answer.',
  stalled: 'The run stopped making progress.',
  internal: 'Something went wrong on our side.',
}

export function isRunFailure(value: unknown): value is RunFailure {
  return typeof value === 'string' && Object.hasOwn(RUN_FAILURES, value)
}

/**
 * One line in a run's log: what it planned, searched, read, skipped (with the
 * reason) and wrote. Labels and details are written for people.
 */
export type StepKind = 'plan' | 'search' | 'read' | 'skip' | 'note' | 'write' | 'error'

export interface RunStep {
  seq: number
  kind: StepKind
  label: string
  detail: string | null
  /** The page a read or skip was about. */
  url: string | null
  at: number
}

/** A page the run read, numbered as the report cites it: [n]. */
export interface RunSource {
  n: number
  url: string
  title: string
  host: string
  /** Whether the report cites it. */
  cited: boolean
}

export interface RunSummary {
  id: string
  question: string
  status: RunStatus
  failure: RunFailure | null
  sourceCount: number
  createdAt: number
  updatedAt: number
}

export interface RunDetail extends RunSummary {
  queries: string[]
  steps: RunStep[]
  sources: RunSource[]
  /** Markdown; every [n] in it is a source above. */
  report: string | null
}

/**
 * GET /api/runs/:id/stream, one JSON object per line: the whole run each time
 * it changes, until it ends; ping keeps the connection open in between.
 */
export type RunStreamEvent = { t: 'run'; run: RunDetail } | { t: 'ping' }

/**
 * The report as the Runs page renders it: each [n] becomes a link to source n.
 * The addresses are ones the run read and checked (agent/research.ts).
 */
export function linkCitations(report: string, sources: Pick<RunSource, 'n' | 'url'>[]): string {
  const byNumber = new Map(sources.map((s) => [s.n, s.url.replace(/\(/g, '%28').replace(/\)/g, '%29')]))
  return report.replace(/\[(\d{1,3})\](?!\()/g, (whole, n: string) => {
    const url = byNumber.get(Number(n))
    return url ? `[\\[${n}\\]](${url})` : whole
  })
}
