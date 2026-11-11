import { RESEARCH_LIMITS } from '../lib/limits'
import { TAVILY_LIMITS } from '../lib/limits'
import { log } from '../lib/log'
import type { TavilyBudget } from './tavily-budget'

/**
 * Web search for research runs: Tavily, which returns each page's text with
 * the result. It is research's only search (owner, 2026-11-10): when Tavily
 * has no key, is out of credits or fails, the search fails with the reason
 * (SearchError) and the run says so.
 */

export interface SearchResult {
  url: string
  title: string
  /** The page's text, when the search service sent it. Untrusted. */
  text?: string
}

export class TavilyError extends Error {
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

/** One Tavily search, with each result's page text unless `pageText` is false. Throws TavilyError. */
export async function tavilySearch(
  query: string,
  options: {
    apiKey: string
    baseUrl?: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    /** Fewer results (the daily model check asks for one). */
    maxResults?: number
    pageText?: boolean
  }
): Promise<SearchResult[]> {
  const maxResults = Math.min(options.maxResults ?? RESEARCH_LIMITS.resultsPerSearch, RESEARCH_LIMITS.resultsPerSearch)
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
        max_results: maxResults,
        search_depth: 'basic',
        include_raw_content: options.pageText === false ? false : 'text',
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
    .slice(0, maxResults)
    .map((r) => ({
      url: r.url as string,
      title: typeof r.title === 'string' ? r.title : '',
      text: typeof r.raw_content === 'string' && r.raw_content.trim() ? r.raw_content : undefined,
    }))
}

/** Why a search couldn't run. */
export type SearchFailure = 'no_key' | 'out_of_credits' | 'rejected' | 'error'

export class SearchError extends Error {
  constructor(readonly reason: SearchFailure) {
    super(`search ${reason}`)
    this.name = 'SearchError'
  }
}

/**
 * Tavily's answers that mean "no more searches on this key for now": 432 and
 * 433 are its plan and pay-as-you-go limits, 429 its rate limit.
 */
function failureOf(error: unknown): SearchFailure {
  const status = error instanceof TavilyError ? error.status : undefined
  if (status === 429 || status === 432 || status === 433) return 'out_of_credits'
  if (status === 401 || status === 403) return 'rejected'
  return 'error'
}

/** Searches with Tavily. Throws SearchError when it can't (or the abort reason when cancelled). */
export async function searchWeb(
  query: string,
  options: {
    tavilyKey?: string
    tavilyBaseUrl?: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    /** Counts the search's credit against the month's cap; without it nothing is counted. */
    budget?: TavilyBudget
  }
): Promise<SearchResult[]> {
  const started = Date.now()
  if (!options.tavilyKey) {
    log.warn('research.search_failed', { provider: 'tavily', code: 'no_key' })
    throw new SearchError('no_key')
  }
  const credits = TAVILY_LIMITS.searchCredits
  if (options.budget && !(await options.budget.reserve(credits))) {
    // The month's share is used: the same as Tavily saying it is out of credits.
    log.warn('research.search_failed', { provider: 'tavily', code: 'monthly_cap' })
    throw new SearchError('out_of_credits')
  }
  try {
    const results = await tavilySearch(query, {
      apiKey: options.tavilyKey,
      baseUrl: options.tavilyBaseUrl,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
    log.info('research.search', { provider: 'tavily', count: results.length, ms: Date.now() - started })
    return results
  } catch (error) {
    // An aborted call may have been charged, so it stays counted; any other failure was not.
    if (options.signal?.aborted) throw error
    await options.budget?.release(credits).catch(() => undefined)
    const reason = failureOf(error)
    log.warn('research.search_failed', {
      provider: 'tavily',
      code: reason,
      upstreamStatus: error instanceof TavilyError ? error.status : undefined,
      ms: Date.now() - started,
    })
    throw new SearchError(reason)
  }
}
