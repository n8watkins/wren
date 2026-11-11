import { TAVILY_LIMITS, utcMonth } from './limits'

/**
 * The monthly Tavily credit cap and this month's count, readable without
 * importing the agent (agent/tavily-budget.ts does the counting).
 */

/** The one DailyCounter instance that holds the month's Tavily credits. */
export const TAVILY_COUNTER_NAME = 'tavily-credits'

/** The monthly cap: TAVILY_MONTHLY_CREDITS, or the default when it is missing or not a whole number of 0 or more. */
export function monthlyCap(value: string | undefined): number {
  const cap = Number(value?.trim() || NaN)
  return Number.isInteger(cap) && cap >= 0 ? cap : TAVILY_LIMITS.monthlyCredits
}

/** This month's credits used and the cap, for /api/health. */
export async function tavilyUsage(env: CloudflareEnv): Promise<{ month: string; used: number; cap: number }> {
  return {
    month: utcMonth(),
    used: await env.DAILY_COUNTER.getByName(TAVILY_COUNTER_NAME).usedThisMonth(),
    cap: monthlyCap(env.TAVILY_MONTHLY_CREDITS),
  }
}
