import { monthlyCap, TAVILY_COUNTER_NAME } from '../lib/tavily-credits'
import { giveBack, tryTake, used } from './meter'
import type { Sql } from './sql'

/**
 * Wren's monthly Tavily credit counter. Tavily's free account (1,000 credits
 * a month, shared with PortfolioRank) is the only paid-for resource research
 * uses, so each call reserves its credits here first and a call that would
 * pass the cap never leaves the Worker; research then stops exactly as if
 * Tavily itself were out of credits (SearchError 'out_of_credits').
 *
 * The count lives in one Durable Object instance (DailyCounter named
 * TAVILY_COUNTER_NAME), which runs one request at a time, so two searches
 * can't both reserve the last credit. It reuses the daily meter's table with
 * the month (YYYY-MM) as the period; Tavily resets on the 1st, UTC.
 */

const KIND = 'tavily'
/** Counts without limiting (the daily model check's probe is always allowed). */
const NO_LIMIT = Number.MAX_SAFE_INTEGER

export function takeMonthly(sql: Sql, month: string, limit: number, credits: number): boolean {
  return tryTake(sql, month, KIND, limit, credits)
}

export function recordMonthly(sql: Sql, month: string, credits: number): void {
  tryTake(sql, month, KIND, NO_LIMIT, credits)
}

export function giveBackMonthly(sql: Sql, month: string, credits: number): void {
  giveBack(sql, month, KIND, credits)
}

export function usedMonthly(sql: Sql, month: string): number {
  return used(sql, month, KIND)
}

/** What a search needs to count its credits. */
export interface TavilyBudget {
  /** Takes the credits if that stays within the month's cap; false when it would not. */
  reserve(credits: number): Promise<boolean>
  /** Gives credits back for a call Tavily did not charge for. */
  release(credits: number): Promise<void>
  /** Counts credits without the cap. */
  record(credits: number): Promise<void>
}

export function tavilyBudget(env: CloudflareEnv): TavilyBudget {
  const counter = () => env.DAILY_COUNTER.getByName(TAVILY_COUNTER_NAME)
  const cap = monthlyCap(env.TAVILY_MONTHLY_CREDITS)
  return {
    reserve: (credits) => counter().takeMonthly(cap, credits),
    release: (credits) => counter().giveBackMonthly(credits),
    record: (credits) => counter().recordMonthly(credits),
  }
}
