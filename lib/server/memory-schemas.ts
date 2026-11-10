import 'server-only'
import { z } from 'zod'
import { HttpError } from './http'
import { USER_KEY_HEADER, userKey } from './schemas'
import { MEMORY_KINDS, MEMORY_LIMITS } from '../memory'

/**
 * Memory's request schemas. Like lib/server/schemas.ts, every object is
 * strict: an unknown field (a userId, an origin, a namespace) is a 400.
 * Whose memory it is comes only from the session.
 */

const memoryId = z.uuid()

const memoryKind = z.enum(MEMORY_KINDS as [string, ...string[]])

/** A web address: http or https only, stored in its normalized form. */
const webUrl = z
  .string()
  .trim()
  .max(MEMORY_LIMITS.urlChars)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0 && !url.username && !url.password
    } catch {
      return false
    }
  }, 'an http or https address')
  .transform((value) => new URL(value).href)
  .pipe(z.string().max(MEMORY_LIMITS.urlChars))

const title = z.string().trim().max(MEMORY_LIMITS.titleChars)
const noteText = z.string().trim().min(1).max(MEMORY_LIMITS.noteChars)

export const newMemory = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('note'), text: noteText }),
  z.strictObject({ kind: z.literal('link'), url: webUrl, title: title.optional() }),
])

export const memoryPatch = z
  .strictObject({
    title: title.optional(),
    text: z.string().trim().max(MEMORY_LIMITS.noteChars).optional(),
    url: webUrl.optional(),
  })
  .refine((patch) => patch.title !== undefined || patch.text !== undefined || patch.url !== undefined, {
    message: 'nothing to change',
  })

export const memoryListQuery = z.strictObject({
  q: z.string().trim().max(MEMORY_LIMITS.queryChars).optional(),
  kind: memoryKind.optional(),
})

/** The uploaded file's name, sent URL-encoded in X-File-Name. */
export const FILE_NAME_HEADER = 'x-file-name'
export const fileName = z.string().trim().min(1).max(MEMORY_LIMITS.titleChars)

/** The person's own Gemini key from this request (as chat takes it), or undefined. */
export function userKeyFrom(request: Request): string | undefined {
  const raw = request.headers.get(USER_KEY_HEADER)
  if (raw === null) return undefined
  const checked = userKey.safeParse(raw)
  if (!checked.success) throw new HttpError('user_key_invalid')
  return checked.data
}

export function idFrom(params: { id: string }): string {
  const parsed = memoryId.safeParse(params.id)
  if (!parsed.success) throw new HttpError('memory_not_found')
  return parsed.data
}
