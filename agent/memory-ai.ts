import type { Sql } from './sql'
import { GeminiError, embedText, generateJson } from './gemini'
import { chooseKey } from './keys'
import { MemoryAiError, type MemoryAi } from './memory'
import { giveBack, tryTake } from './meter'
import { EMBEDDING_DIMENSIONS, MEMORY_LIMITS } from '../lib/memory'
import { utcDay } from '../lib/limits'

/**
 * Memory's Gemini calls for one request, behind the person's meter: the
 * person's own key when they sent one (no limit, and a rejected key is their
 * error to see), otherwise the demo key with MEMORY_LIMITS.dailyAiCalls a day.
 * A call that fails upstream gives its unit back.
 */
export function memoryAi(options: {
  sql: Sql
  userKey?: string
  demoKey?: string
  embeddingModel: string
  model: string
  fallbackModel?: string
  baseUrl?: string
}): MemoryAi {
  const key = chooseKey(options.userKey, options.demoKey)
  const metered = async <T>(call: (key: { apiKey: string; keySource: 'demo' | 'user' }) => Promise<T>): Promise<T> => {
    if (!key) throw new MemoryAiError('demo_unavailable')
    const day = utcDay()
    if (key.keySource === 'demo' && !tryTake(options.sql, day, 'memory', MEMORY_LIMITS.dailyAiCalls)) {
      throw new MemoryAiError('memory_daily_limit')
    }
    try {
      return await call(key)
    } catch (error) {
      if (key.keySource === 'demo') giveBack(options.sql, day, 'memory')
      throw new MemoryAiError(error instanceof GeminiError ? error.code : 'upstream_error')
    }
  }
  return {
    embed: (text) =>
      metered((k) =>
        embedText({ ...k, baseUrl: options.baseUrl, model: options.embeddingModel, text, dimensions: EMBEDDING_DIMENSIONS })
      ),
    json: (request) =>
      metered((k) =>
        generateJson({ ...k, ...request, baseUrl: options.baseUrl, model: options.model, fallbackModel: options.fallbackModel })
      ),
  }
}
