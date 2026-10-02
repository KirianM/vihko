// A request's JSON body, which is an object: `null`, a number, a string or
// a list is 400 `invalid`, never taken apart by a route (which failed with a
// 500 and a trace in the log, the first boot's and an invitation's routes
// included, which need no session).
import type { Context } from 'hono'
import { RequestError } from '../scoped.ts'

export async function jsonBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  const value: unknown = await c.req.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RequestError(400, 'invalid', 'the body must be a JSON object')
  return value as T
}
