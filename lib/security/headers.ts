/**
 * Security headers for every response the Worker sends (worker/index.ts).
 *
 * Scripts run only with this request's nonce ('strict-dynamic' lets Next's own
 * scripts load their chunks). Next reads the nonce from the request's
 * Content-Security-Policy header and puts it on every script it renders, so the
 * Worker sets the same policy on the request it hands to Next and on the
 * response. Styles allow 'unsafe-inline' because React style attributes need it;
 * nothing the model writes is ever rendered as HTML (components/chat/Markdown.tsx).
 */

/** Cloudflare Turnstile, the human check before a guest's first message. */
const TURNSTILE = 'https://challenges.cloudflare.com'

export interface CspOptions {
  nonce: string
  /** `next dev` needs eval for React's debugging and a websocket for HMR. */
  dev?: boolean
  /** Only an https page may upgrade its requests (localhost previews are http). */
  https?: boolean
}

export function buildContentSecurityPolicy({ nonce, dev = false, https = false }: CspOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // 'strict-dynamic' lets our nonced scripts load Turnstile's; the host is the fallback for older browsers.
    'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", TURNSTILE, ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    // Avatars are initials, model output may not load images, so no remote hosts.
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...(dev ? ['ws:'] : [])],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-src': [TURNSTILE],
    'frame-ancestors': ["'none'"],
  }
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`)
  if (https) policy.push('upgrade-insecure-requests')
  return policy.join('; ')
}

/** The headers every response gets, apart from the CSP. */
export function staticSecurityHeaders({ https = false }: { https?: boolean } = {}): [string, string][] {
  return [
    ...(https ? ([['Strict-Transport-Security', 'max-age=63072000; includeSubDomains']] as [string, string][]) : []),
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
    // The mic is for Wren's own voice mode (next update); everything else is off.
    [
      'Permissions-Policy',
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), display-capture=(), browsing-topics=()',
    ],
  ]
}

/** 16 random bytes, base64: unpredictable and unique per request. */
export function createNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
