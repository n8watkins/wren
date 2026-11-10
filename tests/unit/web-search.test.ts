import { describe, expect, it } from 'vitest'
import { SearchError, searchWeb, tavilySearch } from '../../agent/web-search'

function tavily(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const RESULTS = {
  results: [
    { url: 'https://a.example.org/1', title: 'One', content: 'snippet', raw_content: 'Full text of one.' },
    { url: 'https://b.example.org/2', title: 'Two', content: 'snippet', raw_content: null },
    { title: 'No address' },
  ],
}

describe('Tavily', () => {
  it('sends the key as a bearer token and asks for page text', async () => {
    const { fetchImpl, calls } = tavily(200, RESULTS)
    const results = await tavilySearch('e-bikes', { apiKey: 'tvly-key', baseUrl: 'https://tavily.test', fetchImpl })
    expect(calls[0].url).toBe('https://tavily.test/search')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer tvly-key')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toMatchObject({ query: 'e-bikes', max_results: 5, include_raw_content: 'text' })
    expect(body).not.toHaveProperty('api_key')
    expect(results).toEqual([
      { url: 'https://a.example.org/1', title: 'One', text: 'Full text of one.' },
      { url: 'https://b.example.org/2', title: 'Two', text: undefined },
    ])
  })
})

describe('searching', () => {
  it('returns Tavily’s results', async () => {
    const results = await searchWeb('q', { tavilyKey: 'k', fetchImpl: tavily(200, RESULTS).fetchImpl })
    expect(results.map((r) => r.url)).toEqual(['https://a.example.org/1', 'https://b.example.org/2'])
  })

  it('fails as no_key without a Tavily key, without calling anything', async () => {
    const { fetchImpl, calls } = tavily(200, RESULTS)
    await expect(searchWeb('q', { fetchImpl })).rejects.toEqual(new SearchError('no_key'))
    expect(calls).toHaveLength(0)
  })

  it.each([
    [432, 'out_of_credits'],
    [433, 'out_of_credits'],
    [429, 'out_of_credits'],
    [401, 'rejected'],
    [403, 'rejected'],
    [500, 'error'],
    [502, 'error'],
  ] as const)('fails with the reason when Tavily answers %i', async (status, reason) => {
    await expect(searchWeb('q', { tavilyKey: 'k', fetchImpl: tavily(status).fetchImpl })).rejects.toMatchObject({ name: 'SearchError', reason })
  })

  it('fails as error when Tavily cannot be reached or sends nonsense', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const garbage = (async () => new Response('<html>', { status: 200 })) as typeof fetch
    for (const fetchImpl of [down, garbage]) {
      await expect(searchWeb('q', { tavilyKey: 'k', fetchImpl })).rejects.toMatchObject({ name: 'SearchError', reason: 'error' })
    }
  })

  it('passes a cancel on as it is, not as a search failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const abort = new DOMException('aborted', 'AbortError')
    const fetchImpl = (async () => {
      throw abort
    }) as typeof fetch
    const failure = await searchWeb('q', { tavilyKey: 'k', fetchImpl, signal: controller.signal }).catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(SearchError)
  })
})
