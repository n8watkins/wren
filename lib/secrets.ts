/**
 * Optional secrets and test-only settings that wrangler.jsonc doesn't declare
 * (wrangler types only knows the required ones). Read them through here so a
 * missing one is an explicit `undefined`, never a crash or a silent default.
 */
export type OptionalSetting =
  | 'GEMINI_API_KEY'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  /** Turnstile's secret for the guest human check. Without it, guest chat is off. */
  | 'TURNSTILE_SECRET_KEY'
  /** Test runs only: a local stand-in for Turnstile's siteverify. /api/health fails if a production deploy has it. */
  | 'TURNSTILE_VERIFY_URL'
  /** Test runs only: the local mock of the Gemini API. /api/health fails if a production deploy has it. */
  | 'GEMINI_BASE_URL'
  /** Local and test runs only: "local" keeps memory's search vectors in the agent's SQLite (Vectorize has no local mode). /api/health fails if a production deploy has it. */
  | 'MEMORY_VECTORS'
  /** Research search (Tavily). Without it, research searches with Gemini's Google Search tool. */
  | 'TAVILY_API_KEY'
  /** Test runs only: the local mock of the Tavily API. /api/health fails if a production deploy has it. */
  | 'TAVILY_BASE_URL'

export function optionalSetting(env: object, name: OptionalSetting): string | undefined {
  const value = (env as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
