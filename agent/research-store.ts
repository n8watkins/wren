import type { Sql } from './sql'
import { RESEARCH_LIMITS } from '../lib/limits'
import {
  isRunFailure,
  type RunDetail,
  type RunFailure,
  type RunSource,
  type RunStatus,
  type RunStep,
  type RunSummary,
  type SearchProvider,
  type SearchedWith,
  type StepKind,
} from '../lib/research'
import { hostOf } from './research-text'

/**
 * One person's research runs, in their own agent's SQLite database, like
 * their chats: nothing here takes a user id. A run's state is saved after
 * every step (agent/research.ts), so a restart picks it up where it was.
 *
 * research_pages holds every page a search found: 'found' until the run tries
 * it, then 'read' (with its source number and text) or 'skipped'.
 */

export function createResearchTables(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS research_runs (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planning', 'searching', 'reading', 'writing', 'done', 'failed', 'cancelled')),
    failure TEXT,
    day TEXT NOT NULL,
    queries TEXT NOT NULL DEFAULT '[]',
    cursor INTEGER NOT NULL DEFAULT 0,
    report TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  sql.exec(`CREATE TABLE IF NOT EXISTS research_steps (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT,
    url TEXT,
    created_at INTEGER NOT NULL
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS research_steps_by_run ON research_steps (run_id, seq)')
  // Added after the first runs: which service answered a search (2026-11-10).
  // Databases from then may also have a backup_reason column, unused since
  // Tavily became the only search; it stays, empty.
  const columns = new Set(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('research_steps')").toArray().map((c) => c.name))
  if (!columns.has('provider')) sql.exec('ALTER TABLE research_steps ADD COLUMN provider TEXT')
  sql.exec(`CREATE TABLE IF NOT EXISTS research_pages (
    run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
    page_key TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    host TEXT NOT NULL,
    search_index INTEGER NOT NULL,
    position INTEGER NOT NULL,
    search_text TEXT,
    state TEXT NOT NULL CHECK (state IN ('found', 'read', 'skipped')),
    n INTEGER,
    text TEXT,
    cited INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, page_key)
  )`)
}

type RunRow = {
  id: string
  question: string
  status: string
  failure: string | null
  day: string
  queries: string
  cursor: number
  report: string | null
  created_at: number
  updated_at: number
}

export interface RunState {
  id: string
  question: string
  status: RunStatus
  failure: RunFailure | null
  day: string
  queries: string[]
  cursor: number
  report: string | null
  createdAt: number
  updatedAt: number
}

function parseQueries(json: string): string[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string') : []
  } catch {
    return []
  }
}

function toState(row: RunRow): RunState {
  return {
    id: row.id,
    question: row.question,
    status: row.status as RunStatus,
    failure: isRunFailure(row.failure) ? row.failure : null,
    day: row.day,
    queries: parseQueries(row.queries),
    cursor: row.cursor,
    report: row.report,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getRunState(sql: Sql, id: string): RunState | null {
  const row = sql.exec<RunRow>('SELECT id, question, status, failure, day, queries, cursor, report, created_at, updated_at FROM research_runs WHERE id = ?', id).toArray()[0]
  return row ? toState(row) : null
}

/** Runs still going, oldest first. */
export function activeRuns(sql: Sql): RunState[] {
  return sql
    .exec<RunRow>(
      "SELECT id, question, status, failure, day, queries, cursor, report, created_at, updated_at FROM research_runs WHERE status IN ('planning', 'searching', 'reading', 'writing') ORDER BY created_at"
    )
    .toArray()
    .map(toState)
}

export function createRun(sql: Sql, question: string, day: string, now = Date.now()): RunState {
  const id = crypto.randomUUID()
  sql.exec(
    "INSERT INTO research_runs (id, question, status, day, created_at, updated_at) VALUES (?, ?, 'planning', ?, ?, ?)",
    id,
    question,
    day,
    now,
    now
  )
  // Keep the newest runs only (never one still going).
  sql.exec(
    `DELETE FROM research_runs WHERE id IN (
      SELECT id FROM research_runs WHERE status IN ('done', 'failed', 'cancelled')
      ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`,
    RESEARCH_LIMITS.runsPerPerson
  )
  return getRunState(sql, id) as RunState
}

export function updateRun(
  sql: Sql,
  id: string,
  change: { status?: RunStatus; failure?: RunFailure | null; queries?: string[]; cursor?: number; report?: string },
  now = Date.now()
): void {
  const run = getRunState(sql, id)
  if (!run) return
  sql.exec(
    'UPDATE research_runs SET status = ?, failure = ?, queries = ?, cursor = ?, report = ?, updated_at = ? WHERE id = ?',
    change.status ?? run.status,
    change.failure === undefined ? run.failure : change.failure,
    JSON.stringify(change.queries ?? run.queries),
    change.cursor ?? run.cursor,
    change.report ?? run.report,
    now,
    id
  )
}

export function addStep(
  sql: Sql,
  runId: string,
  step: {
    kind: StepKind
    label: string
    detail?: string | null
    url?: string | null
    /** For a search: which service answered it. */
    provider?: SearchProvider
  },
  now = Date.now()
): void {
  sql.exec(
    'INSERT INTO research_steps (run_id, kind, label, detail, url, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    runId,
    step.kind,
    step.label,
    step.detail ?? null,
    step.url ?? null,
    step.provider ?? null,
    now
  )
}

/** How many of a run's searches the search service answered. */
export function answeredSearches(sql: Sql, runId: string): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM research_steps WHERE run_id = ? AND kind = 'search' AND provider IS NOT NULL", runId).toArray()[0]?.n ?? 0
}

export function hasStep(sql: Sql, runId: string, kind: StepKind, label: string): boolean {
  return sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM research_steps WHERE run_id = ? AND kind = ? AND label = ?', runId, kind, label).toArray()[0].n > 0
}

/** Adds a page a search found, unless the run already has it. Returns whether it was new. */
export function addFoundPage(
  sql: Sql,
  runId: string,
  page: { key: string; url: string; title: string; searchIndex: number; position: number; searchText?: string }
): boolean {
  const before = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM research_pages WHERE run_id = ? AND page_key = ?', runId, page.key).toArray()[0].n
  if (before > 0) return false
  sql.exec(
    `INSERT INTO research_pages (run_id, page_key, url, title, host, search_index, position, search_text, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'found')`,
    runId,
    page.key,
    page.url,
    page.title,
    hostOf(page.url),
    page.searchIndex,
    page.position,
    page.searchText ?? null
  )
  return true
}

export interface FoundPage {
  key: string
  url: string
  title: string
  host: string
  searchText: string | null
}

type PageRow = { page_key: string; url: string; title: string; host: string; search_text: string | null }

/**
 * The next page to try: each search's top result first, then each one's
 * second, and so on, skipping sites already tried pagesPerHost times. Picked
 * by rank alone; no model (and so no page text) has a say.
 */
export function nextPage(sql: Sql, runId: string): FoundPage | null {
  const tried = new Map<string, number>()
  for (const row of sql.exec<{ host: string; n: number }>(
    "SELECT host, COUNT(*) AS n FROM research_pages WHERE run_id = ? AND state != 'found' GROUP BY host",
    runId
  ).toArray()) {
    tried.set(row.host, row.n)
  }
  const found = sql
    .exec<PageRow>(
      "SELECT page_key, url, title, host, search_text FROM research_pages WHERE run_id = ? AND state = 'found' ORDER BY position, search_index",
      runId
    )
    .toArray()
  const row = found.find((page) => (tried.get(page.host) ?? 0) < RESEARCH_LIMITS.pagesPerHost)
  return row ? { key: row.page_key, url: row.url, title: row.title, host: row.host, searchText: row.search_text } : null
}

export function pageCounts(sql: Sql, runId: string): { read: number; tried: number; found: number } {
  const rows = sql
    .exec<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM research_pages WHERE run_id = ? GROUP BY state', runId)
    .toArray()
  const count = (state: string) => rows.find((r) => r.state === state)?.n ?? 0
  return { read: count('read'), tried: count('read') + count('skipped'), found: count('read') + count('skipped') + count('found') }
}

/** Marks a page read, numbering it as the next source. Returns its number. */
export function markRead(sql: Sql, runId: string, key: string, page: { url: string; title: string; text: string }): number {
  const n = pageCounts(sql, runId).read + 1
  sql.exec(
    "UPDATE research_pages SET state = 'read', n = ?, url = ?, title = ?, host = ?, text = ?, search_text = NULL WHERE run_id = ? AND page_key = ?",
    n,
    page.url,
    page.title,
    hostOf(page.url),
    page.text,
    runId,
    key
  )
  return n
}

export function markSkipped(sql: Sql, runId: string, key: string): void {
  sql.exec("UPDATE research_pages SET state = 'skipped', search_text = NULL WHERE run_id = ? AND page_key = ?", runId, key)
}

/** Whether the run already read this page under another address (a redirect's target). */
export function alreadyRead(sql: Sql, runId: string, url: string): boolean {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM research_pages WHERE run_id = ? AND state = 'read' AND url = ?", runId, url).toArray()[0].n > 0
}

export function readSources(sql: Sql, runId: string): { n: number; url: string; title: string; text: string }[] {
  return sql
    .exec<{ n: number; url: string; title: string; text: string }>(
      "SELECT n, url, title, text FROM research_pages WHERE run_id = ? AND state = 'read' ORDER BY n",
      runId
    )
    .toArray()
}

export function markCited(sql: Sql, runId: string, cited: number[]): void {
  for (const n of cited) sql.exec("UPDATE research_pages SET cited = 1 WHERE run_id = ? AND state = 'read' AND n = ?", runId, n)
}

/** Drops what a finished run no longer needs: the page text and the pages it never tried. */
export function compactRun(sql: Sql, runId: string): void {
  sql.exec("DELETE FROM research_pages WHERE run_id = ? AND state != 'read'", runId)
  sql.exec('UPDATE research_pages SET text = NULL, search_text = NULL WHERE run_id = ?', runId)
}

function summaryOf(sql: Sql, run: RunState): RunSummary {
  return {
    id: run.id,
    question: run.question,
    status: run.status,
    failure: run.failure,
    sourceCount: pageCounts(sql, run.id).read,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

export function listRuns(sql: Sql, limit: number = RESEARCH_LIMITS.runsPerPerson): RunSummary[] {
  return sql
    .exec<RunRow>(
      'SELECT id, question, status, failure, day, queries, cursor, report, created_at, updated_at FROM research_runs ORDER BY created_at DESC LIMIT ?',
      limit
    )
    .toArray()
    .map((row) => summaryOf(sql, toState(row)))
}

export function runDetail(sql: Sql, id: string): RunDetail | null {
  const run = getRunState(sql, id)
  if (!run) return null
  const rows = sql
    .exec<{
      seq: number
      kind: string
      label: string
      detail: string | null
      url: string | null
      provider: string | null
      created_at: number
    }>('SELECT seq, kind, label, detail, url, provider, created_at FROM research_steps WHERE run_id = ? ORDER BY seq', id)
    .toArray()
  const steps: RunStep[] = rows.map((row) => ({
    seq: row.seq,
    kind: row.kind as StepKind,
    label: row.label,
    detail: row.detail,
    url: row.url,
    provider: row.provider === 'tavily' ? row.provider : null,
    at: row.created_at,
  }))
  // Runs from before Tavily was the only search may have 'google' steps; their details say so.
  const searchedWith: SearchedWith = { tavily: rows.filter((row) => row.provider === 'tavily').length }
  const sources: RunSource[] = sql
    .exec<{ n: number; url: string; title: string; host: string; cited: number }>(
      "SELECT n, url, title, host, cited FROM research_pages WHERE run_id = ? AND state = 'read' ORDER BY n",
      id
    )
    .toArray()
    .map((row) => ({ n: row.n, url: row.url, title: row.title, host: row.host, cited: row.cited === 1 }))
  return {
    ...summaryOf(sql, run),
    queries: run.queries,
    steps,
    sources,
    report: run.report,
    searchedWith: searchedWith.tavily > 0 ? searchedWith : null,
  }
}
