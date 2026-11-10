import type { Sql } from './sql'

/**
 * Where memories' search vectors live. In production that is the
 * `wren-memory` Vectorize index, in a namespace of the person's own (their
 * agent's id) on every write and every query, so one person's search can
 * never reach another's memories. Vectorize has no local mode, so local and
 * test runs (MEMORY_VECTORS=local) keep the vectors in the agent's own SQLite
 * database and compare them directly, which is the same isolation by
 * construction.
 */

interface VectorMatch {
  id: string
  score: number
}

export interface VectorStore {
  upsert(id: string, values: number[]): Promise<void>
  /** The closest vectors, best first (cosine similarity, 1 is identical). */
  query(values: number[], topK: number): Promise<VectorMatch[]>
  remove(ids: string[]): Promise<void>
}

/** The slice of a Vectorize binding this uses (wrangler types it as VectorizeIndex). */
export interface VectorIndex {
  upsert(vectors: { id: string; values: number[]; namespace?: string }[]): Promise<unknown>
  query(
    vector: number[],
    options: { topK?: number; namespace?: string; returnValues?: boolean; returnMetadata?: boolean | 'none' | 'indexed' | 'all' }
  ): Promise<{ matches: { id: string; score: number }[] }>
  deleteByIds(ids: string[]): Promise<unknown>
}

/** Vectorize namespaces are at most 64 bytes; a Durable Object id is 64 hex characters. */
const NAMESPACE = /^[0-9a-f]{1,64}$/

export function vectorizeStore(index: VectorIndex, namespace: string): VectorStore {
  if (!NAMESPACE.test(namespace)) throw new Error('bad vector namespace')
  return {
    async upsert(id, values) {
      await index.upsert([{ id, values, namespace }])
    },
    async query(values, topK) {
      const result = await index.query(values, { topK, namespace, returnValues: false, returnMetadata: 'none' })
      return result.matches.map((match) => ({ id: match.id, score: match.score }))
    },
    async remove(ids) {
      // Ids are random UUIDs this agent made, so deleting by id can only reach its own vectors.
      if (ids.length > 0) await index.deleteByIds(ids)
    },
  }
}

function createLocalVectorTable(sql: Sql): void {
  sql.exec('CREATE TABLE IF NOT EXISTS memory_vectors (id TEXT PRIMARY KEY, vector TEXT NOT NULL)')
}

/** Local and test runs: vectors as JSON in the agent's SQLite, compared one by one (at most 500). */
export function sqliteStore(sql: Sql): VectorStore {
  createLocalVectorTable(sql)
  return {
    async upsert(id, values) {
      sql.exec(
        'INSERT INTO memory_vectors (id, vector) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET vector = excluded.vector',
        id,
        JSON.stringify(values)
      )
    },
    async query(values, topK) {
      return sql
        .exec<{ id: string; vector: string }>('SELECT id, vector FROM memory_vectors')
        .toArray()
        .map((row) => ({ id: row.id, score: cosine(values, JSON.parse(row.vector) as number[]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
    },
    async remove(ids) {
      for (const id of ids) sql.exec('DELETE FROM memory_vectors WHERE id = ?', id)
    },
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}
