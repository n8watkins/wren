import { describe, expect, it, vi } from 'vitest'
import { searchWeb, tavilySearch } from '../../agent/web-search'

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

describe('switching to the backup', () => {
  const backupResults = [{ url: 'https://g.example.org/', title: 'From Google' }]

  it('uses Tavily when it answers', async () => {
    const backup = vi.fn(async () => backupResults)
    const search = await searchWeb('q', { tavilyKey: 'k', fetchImpl: tavily(200, RESULTS).fetchImpl, backup })
    expect(search.provider).toBe('tavily')
    expect(search.results).toHaveLength(2)
    expect(backup).not.toHaveBeenCalled()
  })

  it('uses the backup when there is no Tavily key, without calling Tavily', async () => {
    const { fetchImpl, calls } = tavily(200, RESULTS)
    const search = await searchWeb('q', { fetchImpl, backup: async () => backupResults })
    expect(search).toEqual({ provider: 'google', results: backupResults, backupReason: 'no_key' })
    expect(calls).toHaveLength(0)
  })

  it.each([
    [432, 'out_of_credits'],
    [433, 'out_of_credits'],
    [429, 'out_of_credits'],
    [401, 'rejected'],
    [500, 'error'],
    [502, 'error'],
  ])('uses the backup when Tavily answers %i', async (status, reason) => {
    const search = await searchWeb('q', { tavilyKey: 'k', fetchImpl: tavily(status).fetchImpl, backup: async () => backupResults })
    expect(search).toEqual({ provider: 'google', results: backupResults, backupReason: reason })
  })

  it('uses the backup when Tavily cannot be reached or sends nonsense', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const garbage = (async () => new Response('<html>', { status: 200 })) as typeof fetch
    for (const fetchImpl of [down, garbage]) {
      const search = await searchWeb('q', { tavilyKey: 'k', fetchImpl, backup: async () => backupResults })
      expect(search).toMatchObject({ provider: 'google', backupReason: 'error' })
    }
  })

  it('passes the backup’s own failure on', async () => {
    await expect(
      searchWeb('q', {
        fetchImpl: tavily(432).fetchImpl,
        tavilyKey: 'k',
        backup: async () => {
          throw new Error('google down')
        },
      })
    ).rejects.toThrow('google down')
  })

  it('does not switch to the backup when the run was cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as typeof fetch
    const backup = vi.fn(async () => backupResults)
    await expect(searchWeb('q', { tavilyKey: 'k', fetchImpl, signal: controller.signal, backup })).rejects.toBeDefined()
    expect(backup).not.toHaveBeenCalled()
  })
})
