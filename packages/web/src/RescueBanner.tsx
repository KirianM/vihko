// What the person typed that never reached its note (editor/rescue.ts), one
// at a time: why, and the way out: «Save my version as a copy» (next to the
// note, or in their own space if they can't write there any more) or
// «Discard». Shown wherever they are, over the note or Home, until they decide.
import { useState } from 'react'
import { Button } from 'react-aria-components'
import { ApiError, api, type User } from './api.ts'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { noteName } from './ui.tsx'
import { dropRescue, useRescues, type Rescue, type RescueWhy } from './editor/rescue.ts'
import { personalRoot } from '@vihko/core/spaces'

const BODY: Record<RescueWhy, MessageKey> = {
  refused: 'editor.setAsideBody',
  moved: 'rescue.moved',
  movedAway: 'rescue.movedAway',
  gone: 'rescue.gone',
  trashed: 'rescue.trashed',
  readOnly: 'rescue.readOnly',
  session: 'rescue.session',
}

/** «Name (unsent 2026-09-25 10.12).md» in `dir` (with its trailing slash, or ''); never overwrites one that exists. */
async function saveCopy(dir: string, note: string, text: string, name: (note: string, date: string) => string) {
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`
  for (let n = 1; ; n++) {
    const copy = `${dir}${name(note, date)}${n > 1 ? ` ${n}` : ''}.md`
    try {
      // A new uid: two notes with the same one would be the same note for the integrations.
      return (await api.createNote(copy, text, { freshUid: true })).path
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'exists') || n >= 20) throw e
    }
  }
}

/**
 * Next to the note if the person may still write there; otherwise (the
 * folder went, or is no longer theirs to write) at the root of their own space.
 */
async function keepAsCopy(r: Rescue, username: string, name: (note: string, date: string) => string): Promise<string> {
  const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/') + 1) : ''
  const note = noteName(r.path)
  try {
    return await saveCopy(dir, note, r.text, name)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status === 401 || e.code === 'network') throw e
    return await saveCopy(`${personalRoot(username)}/`, note, r.text, name)
  }
}

export function RescueBanner({ user, onCreated }: { user: User; onCreated: (path: string) => void }) {
  const t = useT()
  const rescues = useRescues(user.id)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const r = rescues[0]
  if (!r) return null
  const keep = async () => {
    setBusy(true)
    setError(null)
    try {
      const copy = await keepAsCopy(r, user.username, (note, date) => t('editor.setAsideName', { note, date }))
      dropRescue(r.id)
      onCreated(copy)
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="banner rescue-banner" role="alert">
      <div className="banner-text">
        <b>{t('editor.setAsideTitle')}</b>
        <span>{t(BODY[r.why], { note: noteName(r.path) })} {r.why !== 'refused' && t('rescue.keep')}</span>
        {rescues.length > 1 && <span>{t('rescue.more', { n: rescues.length - 1 })}</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
      <Button className="btn btn-primary" isDisabled={busy} onPress={() => void keep()}>{t('editor.setAsideKeep')}</Button>
      <Button className="btn" isDisabled={busy} onPress={() => { setError(null); dropRescue(r.id) }}>{t('editor.setAsideDiscard')}</Button>
    </div>
  )
}
