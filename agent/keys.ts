import type { KeySource } from './gemini'

/**
 * Which Gemini key a request uses: the person's own key when they sent one,
 * otherwise the demo key. Never one in place of the other: with a personal key
 * the demo key is not even considered, so a rejected personal key can only end
 * in an error the person sees (tests/unit/keys.test.ts).
 */
export function chooseKey(
  userKey: string | undefined,
  demoKey: string | undefined
): { apiKey: string; keySource: KeySource } | null {
  if (userKey) return { apiKey: userKey, keySource: 'user' }
  if (demoKey) return { apiKey: demoKey, keySource: 'demo' }
  return null
}
