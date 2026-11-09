/**
 * Wren has one public address (PUBLIC_URL, wren.n8builds.dev). Sign-in cookies,
 * callbacks and trusted origins belong to it, so a request that reaches the
 * Worker on its workers.dev address is sent there, keeping the path and query.
 * Local and test hosts are never redirected.
 */
export function canonicalRedirect(requestUrl: string, publicUrl: string): string | null {
  const url = new URL(requestUrl)
  const canonical = new URL(publicUrl)
  if (canonical.protocol !== 'https:' || url.host === canonical.host) return null
  if (!url.hostname.endsWith('.workers.dev')) return null
  // Set the path on the canonical URL rather than resolving it: a path such as
  // "//evil.example" would otherwise resolve to another host.
  const target = new URL(canonical.origin)
  target.pathname = url.pathname
  target.search = url.search
  return target.toString()
}
