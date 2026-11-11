import { DurableObject } from 'cloudflare:workers'
import { createMeterTable, giveBack, tryTake } from './meter'
import { utcDay, utcMonth } from '../lib/limits'
import { giveBackMonthly, recordMonthly, takeMonthly, usedMonthly } from './tavily-budget'

/**
 * A daily counter for one key that isn't a person: `ip:<CF-Connecting-IP>` or
 * `email:<sha-256 of the address>`. Durable, so a restart never resets it.
 */
export class DailyCounter extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    createMeterTable(ctx.storage.sql)
  }

  take(kind: string, limit: number, amount = 1): boolean {
    return tryTake(this.ctx.storage.sql, utcDay(), kind, limit, amount)
  }

  /** The instance named TAVILY_COUNTER_NAME only: Tavily credits for the month (agent/tavily-budget.ts). */
  takeMonthly(limit: number, credits: number): boolean {
    return takeMonthly(this.ctx.storage.sql, utcMonth(), limit, credits)
  }

  recordMonthly(credits: number): void {
    recordMonthly(this.ctx.storage.sql, utcMonth(), credits)
  }

  giveBackMonthly(credits: number): void {
    giveBackMonthly(this.ctx.storage.sql, utcMonth(), credits)
  }

  usedThisMonth(): number {
    return usedMonthly(this.ctx.storage.sql, utcMonth())
  }

  /** For /api/health: proves Durable Objects answer, without counting anything. */
  ping(): boolean {
    return true
  }

  giveBack(kind: string, amount = 1): void {
    giveBack(this.ctx.storage.sql, utcDay(), kind, amount)
  }
}
