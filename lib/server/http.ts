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
 * Reads a JSON body of at most `maxBytes`, without trusting Content-Length:
 * the stream is cut off as soon as it goes over.
 */
export async function readJson(request: Request, maxBytes: number = SIZE_LIMITS.requestBytes): Promise<unknown> {
  const type = request.headers.get('content-type') ?? ''
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError('bad_request')
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new HttpError('too_large')
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
      throw new HttpError('too_large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError('bad_request')
  }
}
