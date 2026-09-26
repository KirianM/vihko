// A write's answer over HTTP, the same for every route that writes a note.
import type { Context } from 'hono'
import type { NowHidden } from '../scoped.ts'

/**
 * Its data with the note's ETag (also as the header, when there is one) and,
 * if the write hid the note from the agent that made it (scoped.ts
 * `NowHidden`), `nowHidden: true` with the reason and what it means. It
 * still succeeded: the agent must not take it for a failure and write again.
 */
export function written<T extends { etag?: string | null; nowHidden?: NowHidden }>(c: Context, r: T) {
  const { nowHidden, ...rest } = r
  if (rest.etag) c.header('ETag', `"${rest.etag}"`)
  return nowHidden ? { ...rest, nowHidden: true as const, reason: nowHidden.reason, message: nowHidden.message } : rest
}
