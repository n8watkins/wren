import { RESEARCH_LIMITS } from '../lib/limits'
import { log } from '../lib/log'
import type { BackupReason, SearchProvider } from '../lib/research'

/**
 * Web search for research runs: Tavily first, because it returns each page's
 * text with the result; Gemini's Google Search tool (agent/gemini.ts) as the
 * backup when Tavily has no key, is out of credits, or fails. Which one served
 * each search is logged (provider) and shown in the run.
 */

export interface SearchResult {
  url: string
  title: string
  /** The page's text, when the search service sent it. Untrusted. */
  text?: string
}

export interface WebSearch {
  provider: SearchProvider
  results: SearchResult[]
  backupReason?: BackupReason
}

class TavilyError extends Error {
  constructor(readonly status: number | undefined) {
    super(`tavily ${status ?? 'network'}`)
    this.name = 'TavilyError'
  }
}

const TAVILY_URL = 'https://api.tavily.com'
const TAVILY_TIMEOUT_MS = 15_000

interface TavilyResponse {
  results?: { url?: unknown; title?: unknown; content?: unknown; raw_content?: unknown }[]
}

/** One Tavily search, with each result's page text. Throws TavilyError. */
export async function tavilySearch(
  query: string,
  options: { apiKey: string; baseUrl?: string; signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<SearchResult[]> {
  const timeout = AbortSignal.timeout(TAVILY_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(`${options.baseUrl ?? TAVILY_URL}/search`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        query,
        max_results: RESEARCH_LIMITS.resultsPerSearch,
        search_depth: 'basic',
        include_raw_content: 'text',
        include_answer: false,
        include_images: false,
      }),
    })
  } catch {
    throw new TavilyError(undefined)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new TavilyError(response.status)
  }
  let body: TavilyResponse
  try {
    body = (await response.json()) as TavilyResponse
  } catch {
    throw new TavilyError(response.status)
  }
  return (body.results ?? [])
    .filter((r) => typeof r.url === 'string')
    .slice(0, RESEARCH_LIMITS.resultsPerSearch)
    .map((r) => ({
      url: r.url as string,
      title: typeof r.title === 'string' ? r.title : '',
      text: typeof r.raw_content === 'string' && r.raw_content.trim() ? r.raw_content : undefined,
    }))
}

/**
 * Tavily's answers that mean "no more searches on this key for now": 432 and
 * 433 are its plan and pay-as-you-go limits, 429 its rate limit.
 */
function backupReason(error: unknown): BackupReason {
  const status = error instanceof TavilyError ? error.status : undefined
  if (status === 429 || status === 432 || status === 433) return 'out_of_credits'
  if (status === 401 || status === 403) return 'rejected'
  return 'error'
}

/** Searches with Tavily, or with the backup when Tavily can't. The backup's errors are thrown. */
export async function searchWeb(
  query: string,
  options: {
    tavilyKey?: string
    tavilyBaseUrl?: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    backup: (query: string) => Promise<SearchResult[]>
  }
): Promise<WebSearch> {
  const started = Date.now()
  let reason: BackupReason = 'no_key'
  if (options.tavilyKey) {
    try {
      const results = await tavilySearch(query, {
        apiKey: options.tavilyKey,
        baseUrl: options.tavilyBaseUrl,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
      })
      log.info('research.search', { provider: 'tavily', count: results.length, ms: Date.now() - started })
      return { provider: 'tavily', results }
    } catch (error) {
      if (options.signal?.aborted) throw error
      reason = backupReason(error)
      log.warn('research.search_backup', {
        provider: 'tavily',
        code: reason,
        upstreamStatus: error instanceof TavilyError ? error.status : undefined,
      })
    }
  }
  const results = (await options.backup(query)).slice(0, RESEARCH_LIMITS.resultsPerSearch)
  log.info('research.search', { provider: 'google', code: reason, count: results.length, ms: Date.now() - started })
  return { provider: 'google', results, backupReason: reason }
}
