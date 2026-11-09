import { describe, expect, it } from 'vitest'
import { createMeterTable, giveBack, tryTake, used } from '../../agent/meter'
import { nextUtcMidnight, utcDay } from '../../lib/limits'
import { memorySql } from '../support/sql'

function meter() {
  const sql = memorySql()
  createMeterTable(sql)
  return sql
}

describe('daily meter', () => {
  it('takes units up to the limit and no further', () => {
    const sql = meter()
    for (let i = 0; i < 3; i++) expect(tryTake(sql, '2026-11-09', 'chat', 3)).toBe(true)
    expect(tryTake(sql, '2026-11-09', 'chat', 3)).toBe(false)
    expect(used(sql, '2026-11-09', 'chat')).toBe(3)
  })

  it('counts kinds separately', () => {
    const sql = meter()
    expect(tryTake(sql, '2026-11-09', 'chat', 1)).toBe(true)
    expect(tryTake(sql, '2026-11-09', 'research', 1)).toBe(true)
    expect(tryTake(sql, '2026-11-09', 'chat', 1)).toBe(false)
  })

  it('starts fresh on a new UTC day and forgets old days', () => {
    const sql = meter()
    expect(tryTake(sql, '2026-11-09', 'chat', 1)).toBe(true)
    expect(tryTake(sql, '2026-11-10', 'chat', 1)).toBe(true)
    expect(used(sql, '2026-11-09', 'chat')).toBe(0)
  })

  it('gives units back, never below zero', () => {
    const sql = meter()
    tryTake(sql, '2026-11-09', 'chat', 5)
    giveBack(sql, '2026-11-09', 'chat')
    giveBack(sql, '2026-11-09', 'chat')
    expect(used(sql, '2026-11-09', 'chat')).toBe(0)
  })

  it('refuses a non-positive amount', () => {
    expect(() => tryTake(meter(), '2026-11-09', 'chat', 5, 0)).toThrow()
  })

  it('buckets by UTC day and resets at midnight UTC', () => {
    const late = new Date('2026-11-09T23:59:59-08:00')
    expect(utcDay(late)).toBe('2026-11-10')
    expect(nextUtcMidnight(new Date('2026-11-09T12:00:00Z'))).toBe('2026-11-10T00:00:00.000Z')
  })
})
