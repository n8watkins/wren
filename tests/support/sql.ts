import { DatabaseSync } from 'node:sqlite'
import type { Sql, SqlValue } from '../../agent/sql'

/** node:sqlite behind the same interface as Durable Object SQL storage. */
export function memorySql(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  return {
    db,
    exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
      const statement = db.prepare(query)
      const isRead = /^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)
      const rows = isRead ? (statement.all(...bindings) as T[]) : (statement.run(...bindings), [] as T[])
      return { toArray: () => rows }
    },
  }
}
