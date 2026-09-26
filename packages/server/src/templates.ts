// Templates (D-030): a plain note whose text is copied into a new one, with
// the fixed variables filled in (`renderTemplate`). Through the normal create
// of the note service: never overwriting, born with its own `uid`.
import { posix } from 'node:path'
import { renderTemplate, type CivilDateTime } from '@thoth/core'
import type { User } from './auth.ts'
import { NoteError, type Actor, type NoteService } from './notes.ts'

const actorOf = (u: User): Actor => ({ kind: 'user', id: u.id })

/**
 * Creates `path` with the text of the note `template`, its variables filled
 * in (`renderTemplate`). A template that doesn't exist fails with not_found,
 * or gives an empty note with `missing: 'empty'`. No template: an empty note.
 */
export async function createFromTemplate(notes: NoteService, o: {
  path: string
  template: string | null
  user: User
  now: CivilDateTime
  missing?: 'fail' | 'empty'
  /** Who creates it: the user, or an agent on their behalf. */
  actor?: Actor
}): Promise<{ path: string; etag: string; uid: string | null }> {
  let text = ''
  if (o.template) {
    try {
      text = notes.read(o.template).text
    } catch (err) {
      if (!(err instanceof NoteError) || err.code !== 'not_found' || o.missing !== 'empty') throw err
    }
  }
  const title = posix.basename(o.path).replace(/\.md$/i, '')
  const rendered = renderTemplate(text, { now: o.now, user: o.user.username, title })
  return notes.create(o.path, rendered, o.actor ?? actorOf(o.user), { freshUid: true })
}
