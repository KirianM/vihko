// Notice after a note goes to the trash, with "Restore" as undo. Shown to whoever
// trashed it and to whoever had it open (naming who trashed it). Also after a
// folder went with what it held: "Restore" brings back every entry. Whoever
// may purge the note's history (its folder's manager, or the admin; managed
// history only) does it from here too: the trash keeps the file, the
// history lets it go.
import { useState } from 'react'
import { Button } from 'react-aria-components'
import { ApiError, api } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { Icon, noteName } from './ui.tsx'
import { PurgeDialog, purgedText } from './history/Purge.tsx'
import { usePathLabels } from './spaces.tsx'
import './actions.css'

/**
 * A note moved to the trash: `by` is who did it, null if it was you. With
 * `folder`, a folder deleted with what it held: `path` is the folder, and
 * these are its entries in the trash (`id` is the first).
 */
export interface Trashed {
  id: string
  path: string
  by: string | null
  folder?: string[]
  /** Whether this person may restore it (false: someone else's, where they can't, such as a space deleted with it); unknown until checked. */
  restorable?: boolean
  /** Its shared space was deleted with it. */
  spaceGone?: boolean
}

export function TrashToast({ trashed, canPurge = false, onRestored, onDismiss }: {
  trashed: Trashed
  /** Whether this person may purge the note's history (not a folder's: that is the admin's, in «Recent changes»). */
  canPurge?: boolean
  onRestored: (path: string) => void
  onDismiss: () => void
}) {
  const t = useT()
  const { label: pathLabel } = usePathLabels()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [purging, setPurging] = useState(false)
  const [purged, setPurged] = useState<string | null>(null)
  const name = trashed.folder ? trashed.path.slice(trashed.path.lastIndexOf('/') + 1) : noteName(trashed.path)

  const restore = async () => {
    setBusy(true)
    setError(null)
    try {
      if (trashed.folder) {
        // Each entry: someone else may have restored one already.
        for (const id of trashed.folder) await api.restore(id).catch((err) => { if (!(err instanceof ApiError && err.code === 'not_found')) throw err })
        return onRestored(trashed.path)
      }
      onRestored((await api.restore(trashed.id)).path)
    } catch (err) {
      // Someone else already restored it: just open it again.
      if (!trashed.folder && err instanceof ApiError && err.code === 'not_found' && (await api.note(trashed.path).then(() => true, () => false))) return onRestored(trashed.path)
      setError(errorText(t, err))
      setBusy(false)
    }
  }

  return (
    <div className="toast">
      <span className="toast-icon">{Icon.trash}</span>
      <span className="toast-text" role={trashed.by ? 'alert' : 'status'}>
        {trashed.folder ? t('trash.folderDone', { name }) : trashed.by && trashed.spaceGone ? t('trash.spaceDeletedBy', { user: trashed.by, name }) : trashed.by ? t('trash.doneBy', { user: trashed.by, name }) : t('trash.done', { name })}
        {purged && <span>{purged}</span>}
        {error && <span className="error-text">{error}</span>}
      </span>
      {/* Never a «Restore» that would fail: only where this person may. */}
      {trashed.restorable !== false && <Button className="btn" onPress={() => void restore()} isDisabled={busy}>{t('trash.restore')}</Button>}
      {canPurge && !trashed.folder && !purged && <Button className="btn btn-quiet purge-open" onPress={() => setPurging(true)} isDisabled={busy}>{t('purge.fromTrash')}</Button>}
      <Button className="btn btn-icon btn-quiet" aria-label={t('trash.dismiss')} onPress={onDismiss}>{Icon.close}</Button>
      {purging && <PurgeDialog path={trashed.path} onCancel={() => setPurging(false)} onDone={(r) => { setPurging(false); setPurged(purgedText(t, r, pathLabel)) }} />}
    </div>
  )
}
