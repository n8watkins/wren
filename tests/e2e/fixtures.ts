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
})

export { expect } from '@playwright/test'
