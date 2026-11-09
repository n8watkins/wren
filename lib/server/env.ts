import 'server-only'
import { getCloudflareContext } from '@opennextjs/cloudflare'

/** The Worker's bindings and settings for this request. */
export function getEnv(): CloudflareEnv {
  return getCloudflareContext().env
}

/** Whether this Worker is running the production configuration. */
export function isProduction(env: CloudflareEnv): boolean {
  return env.APP_ENV === 'production'
}
