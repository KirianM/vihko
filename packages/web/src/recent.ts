// Recently opened notes, for the palette with an empty query (each device's
// last note «On opening» is kept in the account instead, onOpen.ts). A
// convenience of this browser: if there's no storage, the list
// stays empty. Each person's own (`vihko.recent.<user id>`), and forgotten
// when their session ends here: whoever signs in next on a shared browser
// never sees, nor opens, the notes the one before was reading.
import { onSessionEnd } from './session.ts'

const PREFIX = 'vihko.recent'
const MAX = 8

/** Whose list it is: the person signed in (null while nobody is). */
let owner: string | null = null

const key = () => (owner === null ? null : `${PREFIX}.${owner}`)

/** The person signed in in this tab: their list from now on. */
export function setRecentOwner(userId: string | null) {
  owner = userId
  // The list from before it was each person's own: nobody's, so it goes.
  try { localStorage.removeItem(PREFIX) } catch { /* no storage */ }
}

export function recentNotes(): string[] {
  const k = key()
  if (k === null) return []
  try {
    const v: unknown = JSON.parse(localStorage.getItem(k) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : []
  } catch { return [] }
}

export function rememberNote(path: string) {
  const k = key()
  if (k === null) return
  const next = [path, ...recentNotes().filter((p) => p !== path)].slice(0, MAX)
  try { localStorage.setItem(k, JSON.stringify(next)) } catch { /* no persistence */ }
}

onSessionEnd(() => {
  const k = key()
  if (k !== null) try { localStorage.removeItem(k) } catch { /* no storage */ }
  owner = null
})
