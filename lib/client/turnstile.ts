'use client'

/**
 * Cloudflare Turnstile in the browser, for a guest's first message. The widget
 * is "interaction-only": most people never see it; when Cloudflare wants an
 * interaction it appears in the given container. The token goes to our own
 * server (/api/guest/start), which checks it with siteverify.
 */
interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | null = null

function load(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')))
    script.onerror = () => {
      loading = null
      reject(new Error('turnstile failed to load'))
    }
    document.head.appendChild(script)
  })
  return loading
}

/** Runs the check and resolves with a one-time token. */
export async function turnstileToken(container: HTMLElement, siteKey: string): Promise<string> {
  const api = await load()
  return new Promise<string>((resolve, reject) => {
    const id = api.render(container, {
      sitekey: siteKey,
      action: 'guest-start',
      appearance: 'interaction-only',
      callback: (token: string) => {
        resolve(token)
        setTimeout(() => api.remove(id), 0)
      },
      'error-callback': () => {
        reject(new Error('turnstile error'))
        setTimeout(() => api.remove(id), 0)
      },
      'expired-callback': () => reject(new Error('turnstile expired')),
    })
  })
}
