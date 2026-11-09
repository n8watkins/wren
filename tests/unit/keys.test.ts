import { ApiError } from '@google/genai'
import { describe, expect, it } from 'vitest'
import { classifyGeminiError } from '../../agent/gemini'
import { chooseKey } from '../../agent/keys'

describe('choosing a Gemini key (no silent fallback)', () => {
  it("uses the person's key whenever they sent one", () => {
    expect(chooseKey('my-own-key', 'demo-key')).toEqual({ apiKey: 'my-own-key', keySource: 'user' })
  })

  it('uses the demo key only when no personal key was sent', () => {
    expect(chooseKey(undefined, 'demo-key')).toEqual({ apiKey: 'demo-key', keySource: 'demo' })
  })

  it('has no key at all rather than inventing one', () => {
    expect(chooseKey(undefined, undefined)).toBeNull()
  })

  it('reports a rejected personal key as the user’s error, never as a reason to switch keys', () => {
    const rejected = new ApiError({ message: 'API key not valid. Please pass a valid API key.', status: 400 })
    expect(classifyGeminiError(rejected, 'user').code).toBe('user_key_invalid')
    expect(classifyGeminiError(new ApiError({ message: 'denied', status: 403 }), 'user').code).toBe('user_key_invalid')
    expect(classifyGeminiError(new ApiError({ message: 'quota', status: 429 }), 'user').code).toBe('user_key_quota')
  })

  it('reports demo-key problems as the service’s, not the person’s', () => {
    expect(classifyGeminiError(new ApiError({ message: 'API key not valid', status: 400 }), 'demo').code).toBe('demo_unavailable')
    expect(classifyGeminiError(new ApiError({ message: 'quota', status: 429 }), 'demo').code).toBe('demo_busy')
    expect(classifyGeminiError(new Error('socket hang up'), 'demo').code).toBe('upstream_error')
  })
})
