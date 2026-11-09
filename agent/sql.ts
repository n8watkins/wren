/**
 * The slice of Durable Object SQLite storage (ctx.storage.sql) the agent's
 * stores use. Every query goes through exec() with ? placeholders and bound
 * values; building SQL from strings is a lint error (eslint.config.mjs).
 * Unit tests pass node:sqlite through the same interface (tests/unit/sql.ts).
 */
export type SqlValue = string | number | null

interface SqlCursor<T> {
  toArray(): T[]
}

export interface Sql {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>
}
