import { defineCloudflareConfig } from '@opennextjs/cloudflare'

// Every page is rendered per request (each one depends on who is signed in and
// carries a fresh CSP nonce), so there is no incremental cache to configure.
export default defineCloudflareConfig({})
