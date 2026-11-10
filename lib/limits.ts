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
  /** Research runs: one network can open several accounts by email (up to signInEmails a day). */
  research: 9,
  /** Memory's Gemini calls (embeddings, reading PDFs, picking facts) on the demo key. */
  memoryAiCalls: 400,
  /** Voice seconds on the demo key (3 people's worth: one network can open several accounts). */
  voiceSeconds: 3 * DAILY_LIMITS.voiceMinutes * 60,
  /** Sign-in emails sent to anyone from one IP. */
  signInEmails: 20,
} as const

/** Sign-in emails per address per day, so nobody can flood an inbox. */
export const DAILY_SIGN_IN_EMAILS_PER_ADDRESS = 5

/**
 * Research runs (agent/research.ts): how much one run may search and read.
 * The daily allowance is DAILY_LIMITS.research.
 */
export const RESEARCH_LIMITS = {
  /** Characters in a research question. */
  questionChars: 500,
  /** Searches a run plans: at least, at most. */
  minQueries: 3,
  maxQueries: 5,
  /** Results kept from each search. */
  resultsPerSearch: 5,
  /** Pages a run reads, and pages it may try before giving up on reaching that. */
  maxPages: 8,
  maxReadAttempts: 12,
  /** Pages read from one site, so one site can't fill the report. */
  pagesPerHost: 2,
  /** Characters of one page's text kept and shown to the model. */
  sourceChars: 12_000,
  /** Runs one person keeps; the oldest go first. */
  runsPerPerson: 50,
  /** A run still going after this long is stopped (and refunded). */
  stalledMs: 10 * 60 * 1000,
} as const

/** Fetching a web page for research (lib/web/fetch-page.ts). */
export const FETCH_LIMITS = {
  bytes: 2 * 1024 * 1024,
  timeoutMs: 10_000,
  redirects: 4,
} as const

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

/**
 * Voice (agent/voice.ts): talking to Wren through Gemini Live. The daily
 * allowance is DAILY_LIMITS.voiceMinutes, counted in seconds as they are used.
 */
export const VOICE_LIMITS = {
  /** Seconds taken from the meter at a time, ahead of use; what isn't used is given back. */
  chunkSeconds: 10,
  /** Wren says how much is left once a session gets this close to the end. */
  warnSeconds: 60,
  /** One session's longest run (Gemini Live ends a connection at about 10 minutes). */
  sessionSeconds: 9 * 60,
  /** A session where nobody has said anything for this long ends, so it can't use up minutes. */
  idleSeconds: 60,
  /** The browser sends audio about every 100 ms; this long without a frame means it's gone. */
  clientSilentMs: 15_000,
  /** How long Gemini Live may take to accept the session. */
  setupMs: 10_000,
  /** How long a voice ticket (POST /api/voice/ticket) is good for. */
  ticketSeconds: 60,
  /** Bytes in one audio frame from the browser (100 ms of 16 kHz 16-bit PCM is 3,200). */
  audioFrameBytes: 32 * 1024,
  /** Characters in a control message from the browser: a typed message, or the start message with a key. */
  controlChars: SIZE_LIMITS.messageChars + SIZE_LIMITS.apiKeyChars + 200,
  /** Earlier messages of the chat given to Gemini Live as context. */
  historyChars: 20_000,
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
