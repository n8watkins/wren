import 'server-only'
import { isProduction } from './env'

/**
 * Sign-in links. Production sends through Cloudflare Email Service (the
 * `send_email` binding; n8builds.dev is onboarded, so no API key). Local and
 * test runs set EMAIL_TRANSPORT=outbox and the link is kept in D1's
 * test_outbox table for scripts/magic-link.mjs and the E2E tests; a production
 * Worker refuses the outbox.
 */
export async function sendSignInEmail(env: CloudflareEnv, to: string, url: string): Promise<void> {
  if (env.EMAIL_TRANSPORT === 'outbox') {
    if (isProduction(env) && new URL(env.PUBLIC_URL).protocol === 'https:') {
      throw new Error('EMAIL_TRANSPORT=outbox is for local runs only')
    }
    await env.DB.prepare('INSERT INTO test_outbox (email, url, created_at) VALUES (?, ?, ?)')
      .bind(to, url, Date.now())
      .run()
    return
  }
  await env.EMAIL.send({
    to,
    from: { email: env.EMAIL_FROM, name: 'Wren' },
    subject: 'Your Wren sign-in link',
    text: signInText(url),
    html: signInHtml(url),
  })
}

function signInText(url: string): string {
  return [
    'Sign in to Wren with this link. It works once and expires in 10 minutes.',
    '',
    url,
    '',
    "If you didn't ask for it, ignore this email: nobody can sign in without the link.",
  ].join('\n')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function signInHtml(url: string): string {
  const href = escapeHtml(url)
  return `<!doctype html><html><body style="margin:0;background:#FBF7F1;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1F1915">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:460px;background:#FFFFFF;border:1px solid #E6DCCE;border-radius:16px" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 28px">
<p style="margin:0 0 4px;font-size:22px;font-weight:700;letter-spacing:-.02em">Sign in to Wren</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#5E5248">Tap the button to sign in. The link works once and expires in 10 minutes.</p>
<a href="${href}" style="display:inline-block;background:#C2461B;color:#FFF7F0;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:12px">Sign in</a>
<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#716559">If you didn't ask for this, ignore it: nobody can sign in without the link.</p>
</td></tr></table></td></tr></table></body></html>`
}
