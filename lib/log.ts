/**
 * The only way the app writes logs (eslint.config.mjs bans console.*
 * elsewhere). An entry is an event name plus counts, codes and durations:
 * the field list below is closed, so a prompt, an answer, an email address,
 * a key or a user id can't be logged by accident.
 */
export interface LogFields {
  route?: string
  status?: number
  code?: string
  ms?: number
  chars?: number
  count?: number
  model?: string
  keySource?: 'demo' | 'user'
  upstreamStatus?: number
  /** The search service a research search went to. */
  provider?: 'tavily'
}

const ALLOWED = new Set<keyof LogFields>([
  'route',
  'status',
  'code',
  'ms',
  'chars',
  'count',
  'model',
  'keySource',
  'upstreamStatus',
  'provider',
])

export function redact(fields: LogFields): LogFields {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key as keyof LogFields)) continue
    if (typeof value === 'string' && value.length > 64) continue
    out[key] = value
  }
  return out as LogFields
}

function write(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
  // eslint-disable-next-line no-console -- this module is the one sanctioned writer
  console[level](JSON.stringify({ level, event, ...redact(fields) }))
}

export const log = {
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
}
