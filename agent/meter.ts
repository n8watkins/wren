import type { Sql } from './sql'

/**
 * Durable daily counters in a Durable Object's own SQLite database: the
 * per-person meter (WrenAgent) and the per-IP and per-address counters
 * (DailyCounter). A Durable Object runs one request at a time and these calls
 * never await between the read and the write, so two requests can't both take
 * the last unit.
 */

export function createMeterTable(sql: Sql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, kind)
    )`
  )
}

export function used(sql: Sql, day: string, kind: string): number {
  const rows = sql
    .exec<{ used: number }>('SELECT used FROM usage_daily WHERE day = ? AND kind = ?', day, kind)
    .toArray()
  return rows[0]?.used ?? 0
}

/** Takes `amount` units if that stays within `limit`; returns whether it did. */
export function tryTake(sql: Sql, day: string, kind: string, limit: number, amount = 1): boolean {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer')
  if (used(sql, day, kind) + amount > limit) return false
  sql.exec(
    `INSERT INTO usage_daily (day, kind, used) VALUES (?, ?, ?)
     ON CONFLICT (day, kind) DO UPDATE SET used = used + excluded.used`,
    day,
    kind,
    amount
  )
  // Yesterday's rows are no longer read; keep the table small.
  sql.exec('DELETE FROM usage_daily WHERE day < ?', day)
  return true
}

/** Gives back units taken for a call that failed through no fault of the user. */
export function giveBack(sql: Sql, day: string, kind: string, amount = 1): void {
  sql.exec(
    'UPDATE usage_daily SET used = MAX(used - ?, 0) WHERE day = ? AND kind = ?',
    amount,
    day,
    kind
  )
}
