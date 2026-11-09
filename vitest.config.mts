import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./', import.meta.url)),
      // Server modules import 'server-only' to keep them out of client bundles; tests run them in Node.
      'server-only': fileURLToPath(new URL('./tests/support/empty.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
