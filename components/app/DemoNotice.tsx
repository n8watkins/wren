'use client'

import type { Region } from '@/lib/region'
import { Icon } from '../Icons'

/**
 * The free-demo notice (owner decision 2026-11-10, docs/DECISIONS.md): Wren's
 * demo key is on Gemini's free tier, so nobody should share personal details
 * with it, and real use belongs on the visitor's own key. Visitors from the
 * EEA, Switzerland and the UK (lib/region.ts, from Cloudflare's country) get a
 * firmer nudge toward their own key; nothing is blocked anywhere.
 */
export const DEMO_NOTICE =
  "This is a free demo running on Google Gemini's free tier. Please don't share personal details (names, contact info, health, finances, anything private) with the demo. For real use, add your own Gemini key."

/** The firmer line for visitors from the EEA, Switzerland and the UK. */
export function regionNudge(region: Region): string | null {
  if (!region.ownKeyAdvised || !region.name) return null
  return `You're visiting from ${region.name}. Google's terms reserve Gemini's free tier from apps used in the UK, the EU/EEA and Switzerland, so please use Wren with your own Gemini key there.`
}

/** The same reminder in the listening view, for what is said out loud. */
export const VOICE_REMINDER = "Free demo on Gemini's free tier: please don't say personal details (names, contact info, health, finances, anything private). For real use, add your own Gemini key."

/** The same reminder, short, where you save to Memory. */
export const MEMORY_REMINDER = "Free demo: don't save personal details (names, contact info, health, finances, anything private). For real use, add your own Gemini key."

/**
 * The notice above the composer: on until dismissed, and gone once a key of
 * your own is on. The "?" dialog and the key dialog show it again.
 */
export function DemoNotice({ region, onKey, onDismiss }: { region: Region; onKey: () => void; onDismiss: () => void }) {
  const nudge = regionNudge(region)
  return (
    <div className={nudge ? 'demo strong' : 'demo'} role="note" aria-label="Free demo" data-testid="demo-notice" data-region={nudge ? 'own-key' : undefined}>
      <Icon name="key" />
      <div className="dtext">
        {nudge && (
          <p className="dnudge" data-testid="demo-nudge">
            {nudge}
          </p>
        )}
        <p>{DEMO_NOTICE}</p>
        <button type="button" className="btn pri" onClick={onKey} data-testid="demo-own-key">
          Use your own key
        </button>
      </div>
      <button type="button" className="dismiss" onClick={onDismiss} aria-label="Dismiss the demo notice" data-testid="demo-dismiss">
        <Icon name="x" />
      </button>
    </div>
  )
}

/** The notice inside a dialog (the "?" dialog and the key dialog): no buttons of its own. */
export function DemoNoticeBox({ region }: { region: Region }) {
  const nudge = regionNudge(region)
  return (
    <div className={nudge ? 'demo inbox strong' : 'demo inbox'} role="note" data-testid="demo-notice-box">
      <Icon name="key" />
      <div className="dtext">
        {nudge && <p className="dnudge">{nudge}</p>}
        <p>{DEMO_NOTICE}</p>
      </div>
    </div>
  )
}
