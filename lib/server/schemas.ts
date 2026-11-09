import 'server-only'
import { z } from 'zod'
import { SIZE_LIMITS } from '../limits'

/**
 * Request schemas. Every object is strict: an unknown field (a userId, a
 * system prompt, a model name) is a 400, never silently ignored or used.
 */

export const chatId = z.uuid()

export const chatRequest = z
  .strictObject({
    chatId: chatId.optional(),
    text: z.string().trim().min(1).max(SIZE_LIMITS.messageChars).optional(),
    regenerate: z.boolean().optional(),
  })
  .refine((body) => body.regenerate === true || body.text !== undefined, {
    message: 'text is required unless regenerating',
  })
  .refine((body) => body.regenerate !== true || body.chatId !== undefined, {
    message: 'regenerate needs a chatId',
  })

export const stopRequest = z.strictObject({ chatId })

/**
 * A person's own Gemini key, sent per request in the X-Gemini-Key header.
 * It is used for that request and dropped: never stored, never logged.
 */
export const userKey = z
  .string()
  .trim()
  .min(20)
  .max(SIZE_LIMITS.apiKeyChars)
  .regex(/^[A-Za-z0-9_.-]+$/)

export const USER_KEY_HEADER = 'x-gemini-key'
