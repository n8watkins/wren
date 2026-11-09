import type { Sql } from './sql'
import { GeminiError, generateText, searchWithGoogle, type GeneratePart } from './gemini'
import { giveBack, tryTake } from './meter'
import {
  activeRuns,
  addFoundPage,
  addStep,
  alreadyRead,
  compactRun,
  createResearchTables,
  createRun,
  getRunState,
  listRuns,
  markCited,
  markRead,
  markSkipped,
  nextPage,
  pageCounts,
  readSources,
  runDetail,
  updateRun,
  type RunState,
} from './research-store'
import {
  PDF_PROMPT,
  PLANNER_PROMPT,
  REPORT_PROMPT,
  finalizeReport,
  hostOf,
  markerId,
  parsePlan,
  reportRequest,
  samePageKey,
  titleFor,
} from './research-text'
import { searchWeb, type BackupReason, type WebSearch } from './web-search'
import type { ErrorCode } from '../lib/errors'
import { DAILY_LIMITS, RESEARCH_LIMITS, utcDay } from '../lib/limits'
import { log } from '../lib/log'
import { RUN_FAILURES, isActive, type RunDetail, type RunFailure, type RunStreamEvent, type RunSummary } from '../lib/research'
import { optionalSetting } from '../lib/secrets'
import { SKIP_REASONS, checkUrl, fetchPage, type PageResult } from '../lib/web/fetch-page'
import { tidy } from '../lib/web/page-text'

/**
 * Research runs, inside the person's own agent: plan 3 to 5 searches, search
 * (Tavily, or Gemini's Google Search as the backup), read up to 8 pages, then
 * write a report where every [n] is a page that was read.
 *
 * A run is a small state machine saved in SQLite (agent/research-store.ts).
 * Each step is one scheduled callback (WrenAgent.researchTick) that does one
 * bounded piece of work (one model call, one search or one page), saves the
 * result and schedules the next. The Agents SDK keeps a scheduled callback
 * until it finishes, so a restart in the middle of a step runs that step
 * again from the saved state; nothing else is lost.
 *
 * A run takes one of the person's daily research runs when it starts and
 * gives it back if it ends without a report (failed, not cancelled). Research
 * always runs on the demo key: a person's own key lives only in their browser
 * and a run carries on after the tab closes.
 */

export interface ResearchDeps {
  generate(request: { systemPrompt: string; parts: GeneratePart[]; json?: boolean }): Promise<string>
  search(query: string): Promise<WebSearch>
  fetchPage(url: string): Promise<PageResult>
  /** Aborted when the run is cancelled. */
  signal: AbortSignal
}

/** Starts a run if the person has none going and has a run left today. */
export function startRun(
  sql: Sql,
  question: string,
  now = new Date()
): { ok: true; run: RunState } | { ok: false; code: 'research_busy' | 'research_daily_limit' } {
  if (activeRuns(sql).length > 0) return { ok: false, code: 'research_busy' }
  const day = utcDay(now)
  if (!tryTake(sql, day, 'research', DAILY_LIMITS.research)) return { ok: false, code: 'research_daily_limit' }
  return { ok: true, run: createRun(sql, question, day, now.getTime()) }
}

/** Ends a run without a report and gives back the day's run it took. */
function fail(sql: Sql, run: RunState, failure: RunFailure): void {
  updateRun(sql, run.id, { status: 'failed', failure })
  addStep(sql, run.id, { kind: 'error', label: 'Stopped without a report', detail: `${RUN_FAILURES[failure]} This run doesn’t count against today’s.` })
  compactRun(sql, run.id)
  giveBack(sql, run.day, 'research')
  log.warn('research.failed', { code: failure, ms: Date.now() - run.createdAt })
}

export function cancelRun(sql: Sql, id: string): boolean {
  const run = getRunState(sql, id)
  if (!run) return false
  if (!isActive(run.status)) return true
  updateRun(sql, id, { status: 'cancelled' })
  addStep(sql, id, { kind: 'note', label: 'Cancelled', detail: 'You stopped this run.' })
  compactRun(sql, id)
  return true
}

function failureOf(error: unknown): RunFailure {
  if (!(error instanceof GeminiError)) return 'internal'
  if (error.code === 'demo_busy') return 'model_busy'
  if (error.code === 'demo_unavailable') return 'model_unavailable'
  return 'model_error'
}

const BACKUP_NOTES: Record<BackupReason, string> = {
  no_key: 'Google Search',
  out_of_credits: 'Google Search (Tavily is out of credits)',
  rejected: 'Google Search (Tavily rejected the key)',
  error: 'Google Search (Tavily didn’t answer)',
}

function resultsLine(search: WebSearch): string {
  const count = search.results.length
  const what = count === 1 ? '1 result' : `${count} results`
  return `${what} from ${search.provider === 'tavily' ? 'Tavily' : BACKUP_NOTES[search.backupReason ?? 'no_key']}`
}

/** Page text the search sent is used when there is enough of it; otherwise the page is fetched. */
const SEARCH_TEXT_MIN = 400
/** Less readable text than this isn't worth citing. */
const PAGE_TEXT_MIN = 200

type ReadOutcome = { ok: true; url: string; title: string; text: string; via: string } | { ok: false; reason: string }

async function readPage(page: { url: string; title: string; searchText: string | null }, deps: ResearchDeps): Promise<ReadOutcome> {
  const searchText = page.searchText ? tidy(page.searchText) : ''
  if (searchText.length >= SEARCH_TEXT_MIN) {
    return { ok: true, url: page.url, title: page.title, text: searchText.slice(0, RESEARCH_LIMITS.sourceChars), via: 'text from the search' }
  }
  const result = await deps.fetchPage(page.url)
  if (!result.ok) return { ok: false, reason: SKIP_REASONS[result.reason] }
  let text: string
  if (result.kind === 'pdf') {
    try {
      text = tidy(await deps.generate({ systemPrompt: PDF_PROMPT, parts: [{ pdf: result.bytes }, { text: 'Write out this document.' }] }))
    } catch (error) {
      if (deps.signal.aborted) throw error
      return { ok: false, reason: 'the PDF couldn’t be read' }
    }
  } else text = result.text
  if (text.length < PAGE_TEXT_MIN) return { ok: false, reason: SKIP_REASONS.no_text }
  return {
    ok: true,
    url: result.url,
    title: result.title || page.title,
    text: text.slice(0, RESEARCH_LIMITS.sourceChars),
    via: result.kind === 'pdf' ? 'PDF' : 'fetched',
  }
}

/**
 * Does the run's next step and saves it. Returns whether there is more to do.
 * Everything a step learns is written only after its I/O, in one synchronous
 * stretch (which a Durable Object commits together), and only if the run is
 * still where the step found it, so a cancel or a repeated step can't write
 * twice.
 */
export async function advanceRun(sql: Sql, runId: string, deps: ResearchDeps, now = Date.now()): Promise<boolean> {
  const run = getRunState(sql, runId)
  if (!run || !isActive(run.status)) return false
  if (now - run.createdAt > RESEARCH_LIMITS.stalledMs) {
    fail(sql, run, 'stalled')
    return false
  }
  const unchanged = () => {
    const current = getRunState(sql, runId)
    return current !== null && current.status === run.status && current.cursor === run.cursor
  }

  try {
    if (run.status === 'planning') {
      // The plan comes from the question alone, before any page is read.
      const answer = await deps.generate({ systemPrompt: PLANNER_PROMPT, parts: [{ text: `Question: ${run.question}` }], json: true })
      if (!unchanged()) return false
      const queries = parsePlan(answer, run.question)
      updateRun(sql, runId, { status: 'searching', queries, cursor: 0 })
      addStep(sql, runId, { kind: 'plan', label: `Planned ${queries.length} searches`, detail: queries.join('\n') })
      return true
    }

    if (run.status === 'searching') {
      const query = run.queries[run.cursor]
      let search: WebSearch | null = null
      if (query !== undefined) {
        try {
          search = await deps.search(query)
        } catch (error) {
          if (deps.signal.aborted) throw error
        }
        if (!unchanged()) return false
        if (search) {
          addStep(sql, runId, { kind: 'search', label: query, detail: resultsLine(search) })
          search.results.forEach((result, position) => {
            const checked = checkUrl(result.url)
            if (!checked.ok) {
              addStep(sql, runId, { kind: 'skip', label: titleFor(result.title, result.url), detail: SKIP_REASONS[checked.reason], url: null })
              return
            }
            addFoundPage(sql, runId, {
              key: samePageKey(checked.url.toString()),
              url: checked.url.toString(),
              title: result.title,
              searchIndex: run.cursor,
              position,
              searchText: result.text?.slice(0, RESEARCH_LIMITS.sourceChars * 2),
            })
          })
        } else {
          addStep(sql, runId, { kind: 'search', label: query, detail: 'The search failed; carrying on with the others.' })
        }
      }
      const cursor = run.cursor + 1
      if (cursor < run.queries.length) {
        updateRun(sql, runId, { cursor })
        return true
      }
      if (pageCounts(sql, runId).found === 0) {
        fail(sql, { ...run, cursor }, 'no_results')
        return false
      }
      updateRun(sql, runId, { status: 'reading', cursor })
      return true
    }

    if (run.status === 'reading') {
      const counts = pageCounts(sql, runId)
      const page = counts.read < RESEARCH_LIMITS.maxPages && counts.tried < RESEARCH_LIMITS.maxReadAttempts ? nextPage(sql, runId) : null
      if (!page) {
        if (counts.read === 0) {
          fail(sql, run, 'no_sources')
          return false
        }
        updateRun(sql, runId, { status: 'writing' })
        return true
      }
      const outcome = await readPage(page, deps)
      if (!unchanged()) return false
      if (outcome.ok && alreadyRead(sql, runId, outcome.url)) {
        markSkipped(sql, runId, page.key)
        addStep(sql, runId, { kind: 'skip', label: titleFor(page.title, page.url), detail: 'the same page as another source', url: page.url })
      } else if (outcome.ok) {
        const title = titleFor(outcome.title, outcome.url)
        const n = markRead(sql, runId, page.key, { url: outcome.url, title, text: outcome.text })
        addStep(sql, runId, { kind: 'read', label: title, detail: `Source ${n} · ${hostOf(outcome.url)} · ${outcome.via}`, url: outcome.url })
      } else {
        markSkipped(sql, runId, page.key)
        addStep(sql, runId, { kind: 'skip', label: titleFor(page.title, page.url), detail: outcome.reason, url: page.url })
      }
      // Bump the run so a repeat of this step after a restart sees the change.
      updateRun(sql, runId, { cursor: run.cursor + 1 })
      return true
    }

    // Writing.
    const sources = readSources(sql, runId)
    const answer = await deps.generate({ systemPrompt: REPORT_PROMPT, parts: [{ text: reportRequest(run.question, sources, markerId()) }] })
    if (!unchanged()) return false
    const { report, cited } = finalizeReport(answer, sources)
    if (!report) throw new GeminiError('upstream_error')
    markCited(sql, runId, cited)
    updateRun(sql, runId, { status: 'done', report })
    addStep(sql, runId, {
      kind: 'write',
      label: 'Wrote the report',
      detail: `Cites ${cited.length} of ${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`,
    })
    compactRun(sql, runId)
    log.info('research.done', { count: sources.length, chars: report.length, ms: Date.now() - run.createdAt })
    return false
  } catch (error) {
    // Cancelled while waiting: cancelRun has already saved that.
    if (deps.signal.aborted) return false
    const current = getRunState(sql, runId)
    if (current && isActive(current.status)) fail(sql, current, failureOf(error))
    return false
  }
}

/* ---------- inside the agent ---------- */

const encoder = new TextEncoder()
/** A watcher's stream ends after this long; the page opens a new one if the run is still going. */
const WATCH_MS = 10 * 60 * 1000
const PING_MS = 15_000
/** A run that hasn't moved for this long, with no step in progress here, gets its next step scheduled again. */
const STUCK_MS = 90_000

type StartResult = { ok: true; run: RunSummary } | { ok: false; code: ErrorCode }

/**
 * The agent's side of research: starting, listing, watching and cancelling
 * runs, and doing each scheduled step. WrenAgent holds one of these.
 */
export class ResearchRuns {
  /** Steps running right now in this instance, by run id, so Cancel can stop them. */
  private readonly working = new Map<string, AbortController>()
  private readonly watchers = new Map<string, Set<() => void>>()
  private ready = false

  constructor(
    private readonly sqlStorage: Sql,
    private readonly env: Cloudflare.Env,
    /** Schedules WrenAgent.researchTick for a run, now. */
    private readonly scheduleTick: (runId: string) => Promise<void>
  ) {}

  private get sql(): Sql {
    if (!this.ready) {
      createResearchTables(this.sqlStorage)
      this.ready = true
    }
    return this.sqlStorage
  }

  async start(question: string): Promise<StartResult> {
    if (!optionalSetting(this.env, 'GEMINI_API_KEY')) return { ok: false, code: 'research_unavailable' }
    const started = startRun(this.sql, question)
    if (!started.ok) return started
    try {
      await this.scheduleTick(started.run.id)
    } catch {
      fail(this.sql, started.run, 'internal')
      return { ok: false, code: 'research_unavailable' }
    }
    log.info('research.started', { chars: question.length })
    return { ok: true, run: listRuns(this.sql, 1)[0] }
  }

  list(): RunSummary[] {
    for (const run of activeRuns(this.sql)) void this.unstick(run)
    return listRuns(this.sql)
  }

  get(id: string): RunDetail | null {
    const run = getRunState(this.sql, id)
    if (run) void this.unstick(run)
    return runDetail(this.sql, id)
  }

  cancel(id: string): RunDetail | null {
    if (!cancelRun(this.sql, id)) return null
    this.working.get(id)?.abort()
    this.notify(id)
    return runDetail(this.sql, id)
  }

  /** The run as NDJSON (RunStreamEvent): now, and again every time it changes, until it ends. */
  watch(id: string): ReadableStream<Uint8Array> | null {
    const run = getRunState(this.sql, id)
    if (!run) return null
    void this.unstick(run)
    let stop = () => undefined as void
    return new ReadableStream<Uint8Array>({
      start: (out) => {
        const send = (event: RunStreamEvent) => {
          try {
            out.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          } catch {
            stop()
          }
        }
        const push = () => {
          const detail = runDetail(this.sql, id)
          if (detail) send({ t: 'run', run: detail })
          if (!detail || !isActive(detail.status)) stop()
        }
        const ping = setInterval(() => send({ t: 'ping' }), PING_MS)
        const limit = setTimeout(() => stop(), WATCH_MS)
        const listeners = this.watchers.get(id) ?? new Set()
        this.watchers.set(id, listeners)
        listeners.add(push)
        stop = () => {
          clearInterval(ping)
          clearTimeout(limit)
          listeners.delete(push)
          if (listeners.size === 0) this.watchers.delete(id)
          try {
            out.close()
          } catch {
            // Already closed or cancelled.
          }
        }
        push()
      },
      cancel: () => stop(),
    })
  }

  /** One step of a run (the scheduled callback). */
  async tick(runId: string): Promise<void> {
    if (this.working.has(runId)) return
    const controller = new AbortController()
    this.working.set(runId, controller)
    let more = false
    try {
      more = await advanceRun(this.sql, runId, this.deps(controller.signal))
    } finally {
      this.working.delete(runId)
      this.notify(runId)
    }
    if (more) await this.scheduleTick(runId)
  }

  private notify(runId: string): void {
    for (const listener of this.watchers.get(runId) ?? []) listener()
  }

  /** The safety net under the scheduler: a run that stopped moving gets its next step scheduled again. */
  private async unstick(run: RunState): Promise<void> {
    if (!isActive(run.status) || this.working.has(run.id) || Date.now() - run.updatedAt < STUCK_MS) return
    try {
      await this.scheduleTick(run.id)
    } catch {
      // The next look tries again.
    }
  }

  private deps(signal: AbortSignal): ResearchDeps {
    const env = this.env
    const gemini = {
      apiKey: optionalSetting(env, 'GEMINI_API_KEY') ?? '',
      keySource: 'demo' as const,
      model: env.GEMINI_MODEL,
      fallbackModel: env.GEMINI_FALLBACK_MODEL || undefined,
      baseUrl: optionalSetting(env, 'GEMINI_BASE_URL'),
      signal,
    }
    return {
      signal,
      generate: (request) => {
        if (!gemini.apiKey) throw new GeminiError('demo_unavailable')
        return generateText({ ...gemini, ...request })
      },
      search: (query) =>
        searchWeb(query, {
          tavilyKey: optionalSetting(env, 'TAVILY_API_KEY'),
          tavilyBaseUrl: optionalSetting(env, 'TAVILY_BASE_URL'),
          signal,
          backup: (q) => searchWithGoogle({ ...gemini, query: q }),
        }),
      fetchPage: (url) => fetchPage(url, { signal }),
    }
  }
}
