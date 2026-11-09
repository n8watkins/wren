import type { NextConfig } from 'next'
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'

// Security headers and the nonce-based CSP are set by the Worker entry
// (worker/index.ts, lib/security/headers.ts), so they apply to every response
// the Worker sends, including errors and static assets served through it.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
}

export default nextConfig

// `next dev` gets the D1 and email bindings from wrangler.jsonc. The Durable
// Objects only run in the Workers runtime: use `npm run preview` for chat.
void initOpenNextCloudflareForDev()
