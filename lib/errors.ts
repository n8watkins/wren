/**
 * Every error the API can answer with, and what the person is told. Shared by
 * the server (status codes) and the UI (the message under the composer).
 */
export const ERRORS = {
  unauthorized: { status: 401, message: 'Sign in to chat with Wren.' },
  bad_request: { status: 400, message: "That request wasn't valid." },
  too_large: { status: 413, message: 'That message is too long.' },
  rate_limited: { status: 429, message: "You're sending messages quickly. Wait a moment and try again." },
  daily_limit: {
    status: 429,
    message: "You've used today's messages on the demo key. Add your own Gemini key to keep going, or come back after midnight UTC.",
  },
  daily_limit_ip: {
    status: 429,
    message: "This network has used today's demo messages. Add your own Gemini key to keep going.",
  },
  chat_not_found: { status: 404, message: "That chat doesn't exist, or it was deleted." },
  busy: { status: 409, message: 'Wren is still answering in this chat.' },
  nothing_to_regenerate: { status: 400, message: 'There is no answer to regenerate here.' },
  memory_not_found: { status: 404, message: "That memory doesn't exist, or it was deleted." },
  message_not_found: { status: 404, message: "That message isn't in this chat anymore." },
  memory_full: { status: 409, message: 'Your memory is full (500 items). Delete something to make room.' },
  memory_files_full: { status: 409, message: 'Your files are using all 25 MB. Delete a file to make room.' },
  memory_file_type: { status: 415, message: 'Memory reads text, Markdown and PDF files.' },
  memory_file_too_large: { status: 413, message: 'That file is over 5 MB.' },
  memory_file_unreadable: { status: 422, message: "Wren couldn't read any text in that file." },
  memory_daily_limit: {
    status: 429,
    message: "Memory has used today's share of the demo key. Add your own Gemini key, or try again after midnight UTC.",
  },
  user_key_invalid: {
    status: 400,
    message: 'Gemini rejected your API key. Check it under "Use your own key"; Wren never switches to the demo key for you.',
  },
  user_key_quota: { status: 429, message: 'Your Gemini key is out of quota for now.' },
  demo_busy: { status: 503, message: 'The demo key is busy right now. Try again shortly, or add your own Gemini key.' },
  demo_unavailable: {
    status: 503,
    message: "The demo key isn't available right now. You can still chat with your own Gemini key.",
  },
  upstream_error: { status: 502, message: "Gemini didn't answer. Try again." },
  guest_required: { status: 401, message: 'Confirm you’re human to try Wren as a guest.' },
  turnstile_failed: { status: 403, message: 'The human check didn’t pass. Try again, or sign in.' },
  guest_unavailable: { status: 503, message: 'Guest chat isn’t available right now. Sign in to chat.' },
  daily_limit_guest: {
    status: 429,
    message: 'You’ve used today’s 5 guest messages. Sign in for 10x more messages, voice, research and memory.',
  },
  daily_limit_guest_ip: { status: 429, message: 'This network has used today’s guest messages. Sign in to keep going.' },
  guest_site_cap: { status: 429, message: 'Guest messages are used up for today; sign in to keep going.' },
  feature_not_ready: { status: 501, message: 'This is coming in the next update.' },
  research_daily_limit_ip: {
    status: 429,
    message: 'This network has used today’s research runs. They come back at midnight UTC.',
  },
  research_daily_limit: {
    status: 429,
    message: 'You’ve used today’s 3 research runs. They come back at midnight UTC.',
  },
  research_busy: { status: 409, message: 'A research run is already going. Let it finish, or cancel it first.' },
  research_unavailable: { status: 503, message: 'Research isn’t available right now. Try again later.' },
  run_not_found: { status: 404, message: "That research run doesn't exist." },
  internal: { status: 500, message: 'Something went wrong on our side.' },
} as const satisfies Record<string, { status: number; message: string }>

export type ErrorCode = keyof typeof ERRORS

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERRORS, value)
}

/** Errors that signing in solves: the UI offers a Sign in button with them. */
export const SIGN_IN_FIXES: ReadonlySet<ErrorCode> = new Set([
  'daily_limit_guest',
  'daily_limit_guest_ip',
  'guest_site_cap',
  'guest_unavailable',
  'turnstile_failed',
])

export function errorMessage(code: unknown): string {
  return isErrorCode(code) ? ERRORS[code].message : ERRORS.internal.message
}
