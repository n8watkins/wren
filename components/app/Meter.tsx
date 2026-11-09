'use client'

import type { UsageSnapshot } from '@/lib/limits'

function pct(used: number, limit: number): string {
  return `${Math.min(100, Math.round((used / Math.max(1, limit)) * 100))}%`
}

/** Today's share of the demo key, or a note that the person's own key is in use. */
export function Meter({
  usage,
  ownKey,
  guest,
  onKey,
  onSignIn,
}: {
  usage: UsageSnapshot
  ownKey: boolean
  guest: boolean
  onKey: () => void
  onSignIn: () => void
}) {
  if (guest && !ownKey) {
    return (
      <div className="meter" data-tip="meter" data-testid="meter">
        <div className="h">
          <span>Guest, today</span>
          <button type="button" onClick={onSignIn}>
            Sign in
          </button>
        </div>
        <div className="mrow">
          <span>Chat</span>
          <span className="t">
            <b style={{ width: pct(usage.chat.used, usage.chat.limit), background: 'var(--text-2)' }} />
          </span>
          <span className="v" data-testid="meter-chat">
            {usage.chat.used}/{usage.chat.limit}
          </span>
        </div>
        <p className="upsell">Sign in for 10x more messages, voice, research and memory.</p>
      </div>
    )
  }
  return (
    <div className="meter" data-tip="meter" data-testid="meter">
      <div className="h">
        <span>{ownKey ? 'Your Gemini key' : 'Demo key, today'}</span>
        <button type="button" onClick={onKey}>
          {ownKey ? 'Manage key' : 'Use your key'}
        </button>
      </div>
      {ownKey ? (
        <p className="own" style={{ margin: 0 }}>
          No daily limit: chat runs on your own key.
        </p>
      ) : (
        <>
          <div className="mrow">
            <span>Chat</span>
            <span className="t">
              <b style={{ width: pct(usage.chat.used, usage.chat.limit), background: 'var(--text-2)' }} />
            </span>
            <span className="v" data-testid="meter-chat">
              {usage.chat.used}/{usage.chat.limit}
            </span>
          </div>
          <div className="mrow">
            <span>Voice</span>
            <span className="t">
              <b style={{ width: pct(usage.voiceMinutes.used, usage.voiceMinutes.limit), background: 'var(--ember-brand)' }} />
            </span>
            <span className="v">
              {usage.voiceMinutes.used}/{usage.voiceMinutes.limit} m
            </span>
          </div>
          <div className="mrow">
            <span>Research</span>
            <span className="t">
              <b style={{ width: pct(usage.research.used, usage.research.limit), background: 'var(--saffron-bright)' }} />
            </span>
            <span className="v">
              {usage.research.used}/{usage.research.limit}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/** The phone header's ring: today's chat messages used on the demo key. */
export function UsageRing({ usage, ownKey, onClick }: { usage: UsageSnapshot; ownKey: boolean; onClick: () => void }) {
  const circumference = 2 * Math.PI * 13
  const share = ownKey ? 0 : Math.min(1, usage.chat.used / Math.max(1, usage.chat.limit))
  const label = ownKey
    ? 'Using your own Gemini key: no daily limit'
    : `${usage.chat.used} of ${usage.chat.limit} messages used today`
  return (
    <button type="button" className="ring2" onClick={onClick} aria-label={label} title={label} data-testid="usage-ring">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="13" fill="none" stroke="var(--surface-3)" strokeWidth="3.5" />
        <circle
          cx="16"
          cy="16"
          r="13"
          fill="none"
          stroke={ownKey ? 'var(--sage-bright)' : 'var(--ember-brand)'}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${(ownKey ? 1 : share) * circumference} ${circumference}`}
        />
      </svg>
      <span aria-hidden="true">{ownKey ? '∞' : usage.chat.used}</span>
    </button>
  )
}
