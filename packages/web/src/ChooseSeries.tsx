// «Today's note» when the series the person chose no longer exists for them
// (`series_gone`: a space renamed or left, a series removed, edit taken
// away), or when they never chose one and none offered is in their own
// space: vihko never moves on to another series by itself, which could write
// tomorrow's note into a shared space. This asks which one to use, saves the
// answer as their choice (as Preferences does) and opens it.
import { useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import type { Series } from '@vihko/core/series'
import { api, type Profile } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { usePathLabels, useSpaces } from './spaces.tsx'
import './agents.css'

export function ChooseSeriesDialog({ series, first = false, onClose, onChosen }: {
  /** The series offered to the person now. */
  series: Series[]
  /** They never chose one (and none is in their own space), rather than one they chose being gone. */
  first?: boolean
  onClose: () => void
  /** Saved as their choice: the profile as it is now. */
  onChosen: (p: Profile) => void
}) {
  const t = useT()
  const { where } = usePathLabels()
  const { me } = useSpaces()
  const [chosen, setChosen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      onChosen(await api.updateProfile({ dailySeries: chosen }))
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }

  return (
    <ModalOverlay className="modal-overlay" isOpen isDismissable onOpenChange={(o) => { if (!o) onClose() }}>
      <Modal className="modal">
        <Dialog className="dialog dialog-narrow">
          <form onSubmit={submit}>
            <div className="dialog-fields">
              <Heading slot="title" className="dialog-title">{t('series.goneTitle')}</Heading>
              <p className="dialog-text">{t(first ? 'series.firstText' : 'series.goneText')}</p>
              <fieldset className="key-fieldset">
                <legend>{t('prefs.series')}</legend>
                {series.map((s) => (
                  <label key={s.id} className="check">
                    <input type="radio" name="series" checked={chosen === s.id} onChange={() => setChosen(s.id)} />
                    <span className="check-text">{s.label ?? s.id}<span className="hint">{where(s.folder.replaceAll('{user}', me))}</span></span>
                  </label>
                ))}
              </fieldset>
              <p className="hint">{t('series.goneHint')}</p>
            </div>
            {error && <p className="error-text dialog-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
              <Button type="submit" className="btn btn-primary" isDisabled={busy || !chosen}>{t('series.goneOpen')}</Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
