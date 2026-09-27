// The person's own preferences (state.db): their timezone, which decides what
// day "today" is, and the daily note (which series «Today» opens and whether
// it opens when thoth does). Reached from the user row of the sidebar, and the
// way to the other settings pages (one's account, «Agents and API», privacy
// and, for the thoth admin, «Users and groups»).
import { useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { api, type Profile, type WorkspaceInfo } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { useBackClose, useMobile } from './mobile.ts'
import { Icon } from './ui.tsx'
import './actions.css'

/** The browser's timezone (IANA name), or UTC if it doesn't say. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function zones(current: string): string[] {
  let all: string[] = []
  try { all = Intl.supportedValuesOf('timeZone') } catch { /* old browser: only the current and the browser's */ }
  return [...new Set([current, browserTimeZone(), 'UTC', ...all])].sort((a, b) => a.localeCompare(b))
}

export function PreferencesDialog({ profile, workspace, onClose, onSaved, onAgents, onPrivacy, onAccount, onUsers }: {
  profile: Profile
  workspace: WorkspaceInfo | null
  onClose: () => void
  onSaved: (p: Profile) => void
  /** Open «Agents and API» or the privacy page (and close this). */
  onAgents: () => void
  onPrivacy: () => void
  /** Open one's account (password, sessions), or «Users and groups» (the thoth admin; null for anyone else). */
  onAccount: () => void
  onUsers: (() => void) | null
}) {
  const t = useT()
  useBackClose(useMobile(), onClose)
  const series = workspace?.daily ?? []
  const [timezone, setTimezone] = useState(profile.timezone ?? browserTimeZone())
  const [dailySeries, setDailySeries] = useState(series.find((s) => s.id === profile.dailySeries)?.id ?? series[0]?.id ?? '')
  const [openDailyOnStart, setOpenDailyOnStart] = useState(profile.openDailyOnStart)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const browser = browserTimeZone()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // The series is only stored when there is a choice to make: with no
      // series, whatever was chosen before stays for when they come back.
      onSaved(await api.updateProfile({ timezone, openDailyOnStart, ...(series.length ? { dailySeries } : {}) }))
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
              <Heading slot="title" className="dialog-title">{t('prefs.title')}</Heading>
              <label className="field">
                <span>{t('prefs.timezone')}</span>
                <select className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {zones(timezone).map((z) => <option key={z} value={z}>{z.replaceAll('_', ' ')}</option>)}
                </select>
                <span className="hint">{t('prefs.timezoneHint')}</span>
              </label>
              {timezone !== browser && (
                <Button className="btn btn-quiet prefs-browser" onPress={() => setTimezone(browser)}>{t('prefs.useBrowser', { tz: browser })}</Button>
              )}
              {series.length > 0 ? (<>
                <label className="field">
                  <span>{t('prefs.series')}</span>
                  <select className="select" value={dailySeries} onChange={(e) => setDailySeries(e.target.value)}>
                    {series.map((s) => <option key={s.id} value={s.id}>{s.label ?? s.id}</option>)}
                  </select>
                  <span className="hint">{t('prefs.seriesHint')}</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={openDailyOnStart} onChange={(e) => setOpenDailyOnStart(e.target.checked)} />
                  <span className="check-text">
                    {t('prefs.openOnStart')}
                    <span className="hint">{t('prefs.openOnStartHint')}</span>
                  </span>
                </label>
              </>) : (
                <p className="dialog-text">{t('prefs.seriesOff')}</p>
              )}
              <div className="prefs-links">
                <Button className="btn btn-quiet prefs-link" onPress={onAccount}>{t('prefs.account')}{Icon.chevron}</Button>
                {onUsers && <Button className="btn btn-quiet prefs-link" onPress={onUsers}>{t('prefs.users')}{Icon.chevron}</Button>}
                <Button className="btn btn-quiet prefs-link" onPress={onAgents}>{t('prefs.agents')}{Icon.chevron}</Button>
                <Button className="btn btn-quiet prefs-link" onPress={onPrivacy}>{t('prefs.privacy')}{Icon.chevron}</Button>
              </div>
            </div>
            {error && <p className="error-text dialog-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
              <Button type="submit" className="btn btn-primary" isDisabled={busy}>{t('prefs.save')}</Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
