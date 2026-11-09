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
  feature_not_ready: { status: 501, message: 'This is coming in the next update.' },
  internal: { status: 500, message: 'Something went wrong on our side.' },
} as const satisfies Record<string, { status: number; message: string }>

export type ErrorCode = keyof typeof ERRORS

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERRORS, value)
}

export function errorMessage(code: unknown): string {
  return isErrorCode(code) ? ERRORS[code].message : ERRORS.internal.message
}
