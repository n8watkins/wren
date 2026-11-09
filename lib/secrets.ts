/**
 * Optional secrets and test-only settings that wrangler.jsonc doesn't declare
 * (wrangler types only knows the required ones). Read them through here so a
 * missing one is an explicit `undefined`, never a crash or a silent default.
 */
export type OptionalSetting =
  | 'GEMINI_API_KEY'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  /** Test runs only: the local mock of the Gemini API. /api/health fails if a production deploy has it. */
  | 'GEMINI_BASE_URL'

export function optionalSetting(env: object, name: OptionalSetting): string | undefined {
  const value = (env as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
