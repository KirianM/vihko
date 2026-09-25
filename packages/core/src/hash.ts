import { createHash } from 'node:crypto'

/** Hash of a note's content. It's the ETag and the basis for optimistic concurrency. */
export function contentHash(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}
