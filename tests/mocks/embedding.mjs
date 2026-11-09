// A stand-in for gemini-embedding-2 (tests/mocks/gemini.mjs and the unit
// tests): words hashed into 768 dimensions, so texts that share words point
// the same way and unrelated texts don't. The retrieval prefixes Wren adds
// ("task: search result | query: ", "title: … | text: ") are left out, and
// each word counts by its first four letters, so "pumps" matches "pump".
const DIMENSIONS = 768
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'my', 'i', 'we', 'with', 'none', 'at', 'be'])

function hash(word) {
  let h = 2166136261
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619)
  return h >>> 0
}

export function mockEmbedding(text, dimensions = DIMENSIONS) {
  const body = String(text)
    .replace(/^task: search result \| query: /, '')
    .replace(/^title: (.*?) \| text: /s, '$1 ')
  const values = new Array(dimensions).fill(0)
  for (const word of body.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(word)) continue
    const h = hash(word.slice(0, 4))
    values[h % dimensions] += h & 1 ? 1 : -1
  }
  const norm = Math.sqrt(values.reduce((n, v) => n + v * v, 0))
  if (norm === 0) values[0] = 1
  return norm === 0 ? values : values.map((v) => v / norm)
}
