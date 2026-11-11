import { describe, expect, it } from 'vitest'
import { createMeterTable } from '../../agent/meter'
import { giveBackMonthly, recordMonthly, takeMonthly, usedMonthly, type TavilyBudget } from '../../agent/tavily-budget'
import { monthlyCap } from '../../lib/tavily-credits'
import { SearchError, searchWeb } from '../../agent/web-search'
import { TAVILY_LIMITS, utcMonth } from '../../lib/limits'
import { memorySql } from '../support/sql'

function counter() {
  const sql = memorySql()
  createMeterTable(sql)
  return sql
}

/** The same calls the Durable Object serves, over an in-memory database; every call is asynchronous like an RPC. */
function budgetOver(sql: ReturnType<typeof counter>, cap: number, month = () => '2026-11'): TavilyBudget {
  return {
    reserve: async (credits) => takeMonthly(sql, month(), cap, credits),
    release: async (credits) => giveBackMonthly(sql, month(), credits),
    record: async (credits) => recordMonthly(sql, month(), credits),
  }
}

const RESULTS = { results: [{ url: 'https://a.example.org/1', title: 'One', raw_content: 'Text.' }] }

function tavily(status = 200) {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response(JSON.stringify(RESULTS), { status })
  }) as typeof fetch
  return { fetchImpl, calls: () => calls }
}

describe('monthly Tavily credits', () => {
  it('counts credits up to the cap and no further', () => {
    const sql = counter()
    for (let i = 0; i < 5; i++) expect(takeMonthly(sql, '2026-11', 5, 1)).toBe(true)
    expect(takeMonthly(sql, '2026-11', 5, 1)).toBe(false)
    expect(usedMonthly(sql, '2026-11')).toBe(5)
  })

  it('refuses a take that would pass the cap and leaves the count alone', () => {
    const sql = counter()
    takeMonthly(sql, '2026-11', 5, 4)
    expect(takeMonthly(sql, '2026-11', 5, 2)).toBe(false)
    expect(usedMonthly(sql, '2026-11')).toBe(4)
  })

  it('starts a new month at zero and forgets the old one', () => {
    const sql = counter()
    takeMonthly(sql, '2026-11', 5, 5)
    expect(takeMonthly(sql, '2026-12', 5, 1)).toBe(true)
    expect(usedMonthly(sql, '2026-11')).toBe(0)
    expect(usedMonthly(sql, '2026-12')).toBe(1)
  })

  it('names the month in UTC, so midnight UTC on the 1st is the reset', () => {
    expect(utcMonth(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11')
    expect(utcMonth(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12')
  })

  it('records past the cap without refusing, then refuses takes, and gives back never below zero', () => {
    const sql = counter()
    recordMonthly(sql, '2026-11', 3)
    recordMonthly(sql, '2026-11', 3)
    expect(usedMonthly(sql, '2026-11')).toBe(6)
    expect(takeMonthly(sql, '2026-11', 3, 1)).toBe(false)
    giveBackMonthly(sql, '2026-11', 10)
    expect(usedMonthly(sql, '2026-11')).toBe(0)
  })

  it('reads the cap from the variable, falling back to the default', () => {
    expect(monthlyCap('750')).toBe(750)
    expect(monthlyCap(' 100 ')).toBe(100)
    expect(monthlyCap('0')).toBe(0)
    for (const bad of [undefined, '', 'many', '-5', '1.5']) expect(monthlyCap(bad)).toBe(TAVILY_LIMITS.monthlyCredits)
  })
})

describe('searching against the cap', () => {
  it('takes one credit per search', async () => {
    const sql = counter()
    await searchWeb('q', { tavilyKey: 'k', fetchImpl: tavily().fetchImpl, budget: budgetOver(sql, 10) })
    expect(usedMonthly(sql, '2026-11')).toBe(TAVILY_LIMITS.searchCredits)
  })

  it('at the cap behaves like Tavily being out of credits, without calling Tavily', async () => {
    const sql = counter()
    const { fetchImpl, calls } = tavily()
    const budget = budgetOver(sql, 1)
    await searchWeb('one', { tavilyKey: 'k', fetchImpl, budget })
    await expect(searchWeb('two', { tavilyKey: 'k', fetchImpl, budget })).rejects.toEqual(new SearchError('out_of_credits'))
    expect(calls()).toBe(1)
    expect(usedMonthly(sql, '2026-11')).toBe(1)
  })

  it('searches again when the month rolls over', async () => {
    const sql = counter()
    const { fetchImpl, calls } = tavily()
    let month = '2026-11'
    const budget = budgetOver(sql, 1, () => month)
    await searchWeb('one', { tavilyKey: 'k', fetchImpl, budget })
    await expect(searchWeb('two', { tavilyKey: 'k', fetchImpl, budget })).rejects.toBeInstanceOf(SearchError)
    month = '2026-12'
    await searchWeb('three', { tavilyKey: 'k', fetchImpl, budget })
    expect(calls()).toBe(2)
  })

  it('gives the credit back when Tavily did not answer or charge', async () => {
    for (const status of [432, 429, 401, 500]) {
      const sql = counter()
      await expect(searchWeb('q', { tavilyKey: 'k', fetchImpl: tavily(status).fetchImpl, budget: budgetOver(sql, 10) })).rejects.toBeInstanceOf(SearchError)
      expect(usedMonthly(sql, '2026-11')).toBe(0)
    }
  })

  it('keeps the credit when the call was cancelled, as Tavily may have charged it', async () => {
    const sql = counter()
    const controller = new AbortController()
    const fetchImpl = (async () => {
      controller.abort()
      throw new Error('aborted')
    }) as typeof fetch
    await expect(searchWeb('q', { tavilyKey: 'k', fetchImpl, signal: controller.signal, budget: budgetOver(sql, 10) })).rejects.toThrow()
    expect(usedMonthly(sql, '2026-11')).toBe(1)
  })

  it('counts nothing without a key', async () => {
    const sql = counter()
    await expect(searchWeb('q', { budget: budgetOver(sql, 10) })).rejects.toEqual(new SearchError('no_key'))
    expect(usedMonthly(sql, '2026-11')).toBe(0)
  })

  it('lets exactly the cap through when many searches arrive at once', async () => {
    const sql = counter()
    const { fetchImpl, calls } = tavily()
    const budget = budgetOver(sql, 5)
    const outcomes = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => searchWeb(`q${i}`, { tavilyKey: 'k', fetchImpl, budget })))
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(5)
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(35)
    expect(calls()).toBe(5)
    expect(usedMonthly(sql, '2026-11')).toBe(5)
  })
})
