import { createHash } from 'node:crypto'

/** Hash del contenido de una nota. Es el ETag y la base de la concurrencia optimista. */
export function contentHash(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}
