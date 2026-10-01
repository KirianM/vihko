// «On opening»: what vihko opens when the person comes in with
// nothing else asked for (no `?note=`, no `?view=`). Their preference
// (Profile `onOpen`), made to take more options: Home, this device's last
// note, a note they chose, or today's note. A note only when it exists and
// they read it now; today's is never created on coming in (no empty
// notes). Anything
// else: Home.
import { api, type Profile } from './api.ts'
import { recentNotes } from './recent.ts'

/** Whether the person can open a note now (it exists and they read it). */
async function opens(path: string): Promise<boolean> {
  try {
    await api.note(path)
    return true
  } catch {
    return false
  }
}

/** The note to open on coming in, or null for Home. */
export async function openingNote(p: Pick<Profile, 'onOpen' | 'onOpenNote'>): Promise<string | null> {
  switch (p.onOpen) {
    case 'last': {
      const last = recentNotes()[0]
      return last && (await opens(last)) ? last : null
    }
    case 'note':
      return p.onOpenNote && (await opens(p.onOpenNote)) ? p.onOpenNote : null
    case 'daily': {
      const today = await api.today().catch(() => null)
      return today?.exists ? today.path : null
    }
    default:
      return null
  }
}
