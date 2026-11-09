/**
 * The client's IP as Cloudflare saw it. CF-Connecting-IP is set by Cloudflare's
 * edge and overwrites anything a client sends; X-Forwarded-For, X-Real-IP and
 * the like are client-controlled and never read (tests/unit/client-ip.test.ts).
 * Local runs without the header share one bucket.
 */
export function clientIp(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip')?.trim()
  if (!ip || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip)) return 'unknown'
  return ip
}
