import { test as base } from '@playwright/test'

/**
 * Each test gets its own client IP (CF-Connecting-IP, from the 198.18.0.0/15
 * benchmarking range), so per-IP limits behave as for separate visitors. Local
 * workerd passes the header through; Cloudflare's edge overwrites it in
 * production, which is why the app may trust it there.
 */
export function randomIp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  return `198.${18 + (bytes[0] & 1)}.${bytes[1]}.${bytes[2] || 1}`
}

export const test = base.extend({
  extraHTTPHeaders: async ({}, provide) => {
    await provide({ 'cf-connecting-ip': randomIp() })
  },
  // The header is for Wren only: on a third-party request (Turnstile's script)
  // Chromium's opaque-response blocking rejects a script fetched with it.
  context: async ({ context, baseURL }, provide) => {
    await context.route(
      (url) => !url.href.startsWith(baseURL ?? ''),
      (route) => {
        const headers = { ...route.request().headers() }
        delete headers['cf-connecting-ip']
        return route.continue({ headers })
      }
    )
    await provide(context)
  },
})

export { expect } from '@playwright/test'
