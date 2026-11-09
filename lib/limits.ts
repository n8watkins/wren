/**
 * Every limit in one place: the daily demo-key allowance shown in the meter,
 * and the size caps the API and the agent enforce. Placeholders chosen with
 * the owner (2026-11-09); change them here and nowhere else.
 */

/** Daily allowance per person on the shared demo key. Resets at midnight UTC. */
export const DAILY_LIMITS = {
  chat: 50,
  voiceMinutes: 10,
  research: 3,
} as const

/**
 * Guests (no account, owner decision 2026-11-09): typed chat only, a few
 * messages a day, nothing saved past the tab. Per guest cookie, per client IP
 * (so many cookies from one network can't multiply it), and a site-wide cap
 * (GUEST_SITE_DAILY_CAP in wrangler.jsonc, default below).
 */
export const GUEST_LIMITS = {
  chat: 5,
  perIp: 15,
  siteDaily: 500,
  /** Earlier turns a guest's browser may send with a message. */
  historyTurns: 24,
  /** How long a guest cookie lasts. */
  cookieSeconds: 60 * 60 * 24,
} as const

/**
 * Daily allowance per client IP on the demo key, so one person with several
 * email addresses can't multiply their share.
 */
export const DAILY_IP_LIMITS = {
  chat: 150,
  /** Sign-in emails sent to anyone from one IP. */
  signInEmails: 20,
} as const

/** Sign-in emails per address per day, so nobody can flood an inbox. */
export const DAILY_SIGN_IN_EMAILS_PER_ADDRESS = 5

export const SIZE_LIMITS = {
  /** Characters in one message. */
  messageChars: 8_000,
  /** Bytes in any JSON request body. */
  requestBytes: 32 * 1024,
  /** Characters in a chat title (the first message, shortened). */
  titleChars: 80,
  /** Messages kept in one chat; the oldest go first. */
  messagesPerChat: 400,
  /** Chats one person keeps; the least recently used go first. */
  chatsPerPerson: 300,
  /** Characters of earlier conversation sent to the model with a new message. */
  historyChars: 60_000,
  /** Characters in a user's own Gemini key. */
  apiKeyChars: 200,
} as const


interface UsageItem {
  used: number
  limit: number
}

export interface UsageSnapshot {
  chat: UsageItem
  voiceMinutes: UsageItem
  research: UsageItem
  /** ISO time of the next reset (midnight UTC). */
  resetsAt: string
}

/** The UTC day a moment falls on, as YYYY-MM-DD: the meter's bucket. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function nextUtcMidnight(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return next.toISOString()
}
