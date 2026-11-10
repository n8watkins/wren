import 'server-only'
import { ERRORS, type ErrorCode } from '../errors'
import { SIZE_LIMITS } from '../limits'

/** A JSON error answer: { error: code, message }. */
export function errorResponse(code: ErrorCode, init: { headers?: HeadersInit } = {}): Response {
  return Response.json(
    { error: code, message: ERRORS[code].message },
    { status: ERRORS[code].status, headers: { 'Cache-Control': 'no-store', ...init.headers } }
  )
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  return Response.json(body, { ...init, headers })
}

export class HttpError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
  }
}

/**
 * Reads a body of at most `maxBytes`, without trusting Content-Length: the
 * stream is cut off as soon as it goes over.
 */
export async function readBytes(
  request: Request,
  maxBytes: number,
  tooLarge: ErrorCode = 'too_large'
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new HttpError(tooLarge)
  if (!request.body) throw new HttpError('bad_request')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new HttpError(tooLarge)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Reads a JSON body of at most `maxBytes` (readBytes). */
export async function readJson(request: Request, maxBytes: number = SIZE_LIMITS.requestBytes): Promise<unknown> {
  const type = request.headers.get('content-type') ?? ''
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError('bad_request')
  const bytes = await readBytes(request, maxBytes)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError('bad_request')
  }
}
