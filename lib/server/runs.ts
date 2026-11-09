import 'server-only'
import { HttpError } from './http'
import { runId } from './schemas'

/** The run id in the address; anything that isn't one is a run that doesn't exist. */
export function runIdFrom(params: { id: string }): string {
  const parsed = runId.safeParse(params.id)
  if (!parsed.success) throw new HttpError('run_not_found')
  return parsed.data
}
