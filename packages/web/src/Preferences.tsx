// The person's own preferences (state.db): their timezone, which decides what
// day "today" is, the daily note (which series «Today» opens) and what vihko
// opens when they come in («On opening»). Reached from the user row
// of the sidebar, and the way to the other settings pages (one's own note
// settings, one's account, «Agents and API», privacy and, for the vihko
// admin, «Users and groups»). Choosing one's daily series and defining one's
// own note settings sit together under one heading, each with a line saying
// which is which.
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { api, type OnOpen, type Profile, type TreeNote, type WorkspaceInfo } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { useBackClose, useMobile } from './mobile.ts'
import { usePathLabels } from './spaces.tsx'
import { Icon } from './ui.tsx'
import './actions.css'

/** The choices of «On opening», in the order they're offered (more can be added). */
const ON_OPEN: readonly OnOpen[] = ['home', 'last', 'note', 'daily']

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The note «On opening» opens, picked by its name from the notes
 * the person reads now (their tree): never typed as a path.
 */
function NotePicker({ value, onChange }: { value: string | null; onChange: (path: string) => void }) {
  const t = useT()
  const labels = usePathLabels()
  const [notes, setNotes] = useState<TreeNote[] | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => { api.tree().then((r) => setNotes(r.notes)).catch(() => setNotes([])) }, [])
  const q = fold(query.trim())
  const matches = q === '' || !notes ? [] : notes.filter((n) => fold(n.title).includes(q) || fold(n.path.slice(n.path.lastIndexOf('/') + 1)).includes(q)).slice(0, 6)
  return (
    <div className="prefs-note">
      {value && <p className="prefs-note-chosen" role="status">{labels.label(value)}</p>}
      <label className="field">
        <span>{t('prefs.onOpenNote')}</span>
        <input className="input" type="search" value={query} placeholder={t('prefs.onOpenNotePlaceholder')} onChange={(e) => setQuery(e.target.value)} />
        <span className="hint">{t('prefs.onOpenNoteHint')}</span>
      </label>
      {q !== '' && notes && (matches.length === 0
        ? <p className="hint">{t('prefs.onOpenNoteNone')}</p>
        : (
          <ul className="prefs-note-list" aria-label={t('prefs.onOpenNote')}>
            {matches.map((n) => (
              <li key={n.path}>
                <Button className="btn btn-quiet prefs-note-item" aria-pressed={value === n.path} onPress={() => { onChange(n.path); setQuery('') }}>
                  <span className="prefs-note-title">{n.title}</span>
                  <span className="hint">{labels.where(n.path, true)}</span>
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}

/** The browser's timezone (IANA name), or UTC if it doesn't say. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function zones(current: string): string[] {
  let all: string[] = []
  try { all = Intl.supportedValuesOf('timeZone') } catch { /* old browser: only the current and the browser's */ }
  return [...new Set([current, browserTimeZone(), 'UTC', ...all])].sort((a, b) => a.localeCompare(b))
}

export function PreferencesDialog({ profile, workspace, onClose, onSaved, onAgents, onPrivacy, onAccount, onUsers, onSpaces, onNoteSettings }: {
  profile: Profile
  workspace: WorkspaceInfo | null
  onClose: () => void
  onSaved: (p: Profile) => void
  /** Open «Agents and API» or the privacy page (and close this). */
  onAgents: () => void
  onPrivacy: () => void
  /** Open one's account (password, sessions), or «Users and groups» (the vihko admin; null for anyone else). */
  onAccount: () => void
  onUsers: (() => void) | null
  /** The admin's directory of shared spaces; null for anyone else. */
  onSpaces: (() => void) | null
  /** One's own note settings (series, templates, images, guide for agents). */
  onNoteSettings: () => void
}) {
  const t = useT()
  useBackClose(useMobile(), onClose)
  const series = workspace?.daily ?? []
  const [timezone, setTimezone] = useState(profile.timezone ?? browserTimeZone())
  const [dailySeries, setDailySeries] = useState(series.find((s) => s.id === profile.dailySeries)?.id ?? series[0]?.id ?? '')
  // «Daily note» is offered only to someone with a series; one chosen before stays shown while it's the choice.
  const [onOpen, setOnOpen] = useState<OnOpen>(profile.onOpen)
  const [onOpenNote, setOnOpenNote] = useState<string | null>(profile.onOpenNote)
  const choices = ON_OPEN.filter((c) => c !== 'daily' || series.length > 0 || profile.onOpen === 'daily')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const browser = browserTimeZone()
  const groupTitle = useId()
  const ownHint = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // The series is only stored when there is a choice to make: with no
      // series, whatever was chosen before stays for when they come back.
      const opening = onOpen === 'note' && !onOpenNote ? 'home' : onOpen
      onSaved(await api.updateProfile({ timezone, onOpen: opening, onOpenNote: opening === 'note' ? onOpenNote : null, ...(series.length ? { dailySeries } : {}) }))
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
              {/* Choosing among the series one has, and defining one's own, side by side: two different things that read as one otherwise. */}
              <div className="prefs-group" role="group" aria-labelledby={groupTitle}>
                <p id={groupTitle} className="prefs-group-title">{t('prefs.notesGroup')}</p>
                {series.length > 0 ? (
                  <label className="field">
                    <span>{t('prefs.series')}</span>
                    <select className="select" value={dailySeries} onChange={(e) => setDailySeries(e.target.value)}>
                      {series.map((s) => <option key={s.id} value={s.id}>{s.label ?? s.id}</option>)}
                    </select>
                    <span className="hint">{t('prefs.seriesHint')}</span>
                  </label>
                ) : (
                  <p className="hint">{t('prefs.seriesOff')}</p>
                )}
                <div className="prefs-own">
                  <Button className="btn btn-quiet prefs-link" aria-describedby={ownHint} onPress={onNoteSettings}>{t('prefs.noteSettings')}{Icon.chevron}</Button>
                  <span id={ownHint} className="hint">{t('prefs.noteSettingsHint')}</span>
                </div>
              </div>
              <fieldset className="prefs-open">
                <legend>{t('prefs.onOpen')}</legend>
                <span className="hint">{t('prefs.onOpenHint')}</span>
                {choices.map((c) => (
                  <label key={c} className="check">
                    <input type="radio" name="on-open" value={c} checked={onOpen === c} onChange={() => setOnOpen(c)} />
                    <span className="check-text">
                      {t(`prefs.onOpen.${c}`)}
                      {c === 'daily' && onOpen === 'daily' && <span className="hint">{t('prefs.onOpenDailyHint')}</span>}
                    </span>
                  </label>
                ))}
                {onOpen === 'note' && <NotePicker value={onOpenNote} onChange={setOnOpenNote} />}
              </fieldset>
              <div className="prefs-links">
                <Button className="btn btn-quiet prefs-link" onPress={onAccount}>{t('prefs.account')}{Icon.chevron}</Button>
                {onUsers && <Button className="btn btn-quiet prefs-link" onPress={onUsers}>{t('prefs.users')}{Icon.chevron}</Button>}
                {onSpaces && <Button className="btn btn-quiet prefs-link" onPress={onSpaces}>{t('prefs.spaces')}{Icon.chevron}</Button>}
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
