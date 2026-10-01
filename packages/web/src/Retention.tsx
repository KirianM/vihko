// «Users and groups» → Retention (the vihko admin): two settings for the
// whole installation, off by default, that the weekly run applies: empty
// the trash after so many days, and delete history versions older than so
// many days or months (each note keeps its current version, and a note in
// the trash its whole history). Turning one on, or shortening it, first
// shows what the next run would remove (counts and sizes, never a path: the
// admin doesn't read every space) and is confirmed with the admin's own code
// or password; anything that removes less is saved at once. «Run now»
// applies what is saved without waiting for the week, with the same preview
// and confirmation. Below, what the last run removed and when the next one is.
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, Modal, ModalOverlay, TextField } from 'react-aria-components'
import { ApiError, api, type AdminSettings, type RetentionCounts, type RetentionStatus } from './api.ts'
import { Toggle } from './Agents.tsx'
import { ConfirmField, codeError, useConfirmWith } from './TwoFactor.tsx'
import { errorText, useLang, useT } from './i18n.tsx'
import { useDates } from './history/ui.tsx'
import './retention.css'

type Unit = 'days' | 'months'
/** What the form holds for one setting: on or off, and how long. */
interface Period { on: boolean; amount: string; unit: Unit }
type Periods = { trashRetentionDays: number | null; historyRetentionDays: number | null }

const MONTH = 30
const MAX_DAYS = 36500

/** A period in days as the form shows it: in months, if it may, when it's a whole number of them. */
function periodOf(days: number | null, fallback: { amount: number; unit: Unit }, months: boolean): Period {
  if (days === null) return { on: false, amount: String(fallback.amount), unit: fallback.unit }
  return months && days % MONTH === 0 ? { on: true, amount: String(days / MONTH), unit: 'months' } : { on: true, amount: String(days), unit: 'days' }
}

/** The form's period in days; null when off; undefined when what's written isn't a valid number. */
function daysOf(p: Period): number | null | undefined {
  if (!p.on) return null
  if (!/^\d+$/.test(p.amount.trim())) return undefined
  const days = Number(p.amount) * (p.unit === 'months' ? MONTH : 1)
  return days >= 1 && days <= MAX_DAYS ? days : undefined
}

/** Whether going from `now` to `next` removes more: one turned on, or shorter. */
function tighter(now: Periods, next: Periods): boolean {
  return (['trashRetentionDays', 'historyRetentionDays'] as const).some((k) => next[k] !== null && (now[k] === null || next[k]! < now[k]!))
}

function useBytes() {
  const lang = useLang()
  return (bytes: number) => {
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
    let i = 0
    let n = bytes
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
    return new Intl.NumberFormat(lang, { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: i === 0 ? 0 : 1 }).format(n)
  }
}

/**
 * Before saving what removes more (`save`), or before a run now (`run`):
 * what the run would remove, and the admin's code or password.
 */
function ConfirmRetention({ next, mode, onClose, onSaved, onRan }: {
  next: Periods
  mode: 'save' | 'run'
  onClose: () => void
  onSaved: (s: AdminSettings) => void
  onRan: () => void
}) {
  const t = useT()
  const bytes = useBytes()
  const how = useConfirmWith()
  const [counts, setCounts] = useState<RetentionCounts | null>(null)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.retentionPreview(next).then(setCounts, (err) => setError(errorText(t, err)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const go = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !secret.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'run') {
        await api.retentionRun(secret.trim())
        onRan()
      } else onSaved(await api.setAdminSettings({ ...next, confirm: secret.trim() }))
    } catch (err) {
      setError(codeError(t, err))
      setBusy(false)
    }
  }
  const items: string[] = []
  if (counts) {
    if (next.trashRetentionDays !== null) {
      items.push(counts.trash.entries === 0 ? t('retention.previewTrashNone') : t(counts.trash.entries === 1 ? 'retention.previewTrashOne' : 'retention.previewTrash', { n: counts.trash.entries, size: bytes(counts.trash.bytes) }))
    }
    if (next.historyRetentionDays !== null) {
      items.push(counts.history === null ? t('retention.previewHistoryOff')
        : counts.history.versions === 0 ? t('retention.previewHistoryNone')
        : t(counts.history.versions === 1 ? 'retention.previewHistoryOne' : 'retention.previewHistory', { n: counts.history.versions, size: bytes(counts.history.bytes) }))
    }
    if (mode === 'save') items.push(t('retention.previewWeekly'))
    items.push(t('retention.previewForGood'))
  }
  // The button says what it does, as the preview counted it: nothing to remove now is only saving (or running).
  const removes = counts !== null && ((next.trashRetentionDays !== null && counts.trash.entries > 0)
    || (next.historyRetentionDays !== null && counts.history !== null && counts.history.versions > 0))
  const confirm = mode === 'run' ? (removes ? 'retention.runConfirm' : 'retention.runNow') : (removes ? 'retention.confirm' : 'retention.save')
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <form onSubmit={(e) => void go(e)}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t(mode === 'run' ? 'retention.runTitle' : 'retention.confirmTitle')}</Heading>
          {counts === null && !error ? <p className="hint">{t('common.loading')}</p> : <ul className="consequences" data-testid="retention-preview">{items.map((x) => <li key={x}>{x}</li>)}</ul>}
          <ConfirmField how={how} value={secret} onChange={setSecret} hint={t('retention.confirmHint')} />
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className={`btn ${removes ? 'btn-danger' : 'btn-primary'}`} isDisabled={busy || counts === null || !secret.trim()}>{t(confirm)}</Button>
        </div>
      </form>
    </Dialog>
  )
}

export function RetentionSection({ settings, onSettings, onUnauthorized }: { settings: AdminSettings; onSettings: (s: AdminSettings) => void; onUnauthorized: () => void }) {
  const t = useT()
  const dates = useDates()
  const saved: Periods = { trashRetentionDays: settings.trashRetentionDays, historyRetentionDays: settings.historyRetentionDays }
  // The trash in days; the history in days or months.
  const fresh = () => ({ trash: periodOf(saved.trashRetentionDays, { amount: 30, unit: 'days' }, false), history: periodOf(saved.historyRetentionDays, { amount: 12, unit: 'months' }, true) })
  const [form, setForm] = useState(fresh)
  const [status, setStatus] = useState<RetentionStatus | null>(null)
  const [confirming, setConfirming] = useState<{ next: Periods; mode: 'save' | 'run' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }
  const load = () => api.retentionStatus().then(setStatus, fail)
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setForm(fresh()) }, [settings.trashRetentionDays, settings.historyRetentionDays]) // eslint-disable-line react-hooks/exhaustive-deps

  const next = { trashRetentionDays: daysOf(form.trash), historyRetentionDays: daysOf(form.history) }
  const valid = next.trashRetentionDays !== undefined && next.historyRetentionDays !== undefined
  const changed = valid && (next.trashRetentionDays !== saved.trashRetentionDays || next.historyRetentionDays !== saved.historyRetentionDays)
  const done = (s: AdminSettings) => { setConfirming(null); onSettings(s); void load() }
  const save = async () => {
    if (!changed) return
    const periods = next as Periods
    if (tighter(saved, periods)) return setConfirming({ next: periods, mode: 'save' })
    setBusy(true)
    setError(null)
    try { done(await api.setAdminSettings(periods)) } catch (err) { fail(err) }
    setBusy(false)
  }

  const amount = (which: 'trash' | 'history', label: string) => (
    <TextField className="field retention-amount" value={form[which].amount} isDisabled={busy}
      onChange={(v) => setForm({ ...form, [which]: { ...form[which], amount: v } })} isInvalid={daysOf(form[which]) === undefined}>
      <Label className="visually-hidden">{label}</Label>
      <Input inputMode="numeric" />
    </TextField>
  )
  const last = status?.lastRun
  return (
    <section className="settings-section" aria-labelledby="retention-title">
      <h2 id="retention-title">{t('retention.title')}</h2>
      <p className="hint">{t('retention.intro')}</p>
      <div className="switches">
        <div className="retention-setting">
          <Toggle label={t('retention.trash')} hint={t('retention.trashHint')} value={form.trash.on} disabled={busy}
            onChange={(on) => setForm({ ...form, trash: { ...form.trash, on } })} />
          {form.trash.on && (
            <div className="retention-period">
              {amount('trash', t('retention.trashAmount'))}
              <span>{t('retention.days')}</span>
            </div>
          )}
        </div>
        <div className="retention-setting">
          <Toggle label={t('retention.history')} hint={t(status && !status.history ? 'retention.historyNotManaged' : 'retention.historyHint')} value={form.history.on}
            disabled={busy || (status !== null && !status.history && !form.history.on)}
            onChange={(on) => setForm({ ...form, history: { ...form.history, on } })} />
          {form.history.on && (
            <div className="retention-period">
              {amount('history', t('retention.historyAmount'))}
              <select className="select" aria-label={t('retention.unit')} value={form.history.unit} disabled={busy}
                onChange={(e) => setForm({ ...form, history: { ...form.history, unit: e.target.value as Unit } })}>
                <option value="days">{t('retention.days')}</option>
                <option value="months">{t('retention.months')}</option>
              </select>
            </div>
          )}
        </div>
        {!valid && <p className="error-text" role="alert">{t('retention.invalid', { max: MAX_DAYS })}</p>}
        {(changed || !valid) ? (
          <div className="retention-actions">
            <Button className="btn" isDisabled={busy} onPress={() => setForm(fresh())}>{t('common.cancel')}</Button>
            <Button className="btn btn-primary" isDisabled={busy || !changed} onPress={() => void save()}>{t('retention.save')}</Button>
          </div>
        ) : (saved.trashRetentionDays !== null || saved.historyRetentionDays !== null) && (
          // What is saved, applied now instead of at the next weekly run.
          <div className="retention-actions">
            <Button className="btn" isDisabled={busy} onPress={() => setConfirming({ next: saved, mode: 'run' })}>{t('retention.runNow')}</Button>
          </div>
        )}
      </div>
      <p className="hint" data-testid="retention-status">
        {last
          ? t(last.failed ? 'retention.lastRunFailed' : 'retention.lastRun', { when: dates.dateTime(last.at), entries: last.trash.entries, versions: last.history?.versions ?? 0 })
          : t('retention.neverRun')}
        {status?.nextRun && <> {t('retention.nextRun', { when: dates.dateTime(status.nextRun) })}</>}
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <ModalOverlay className="modal-overlay" isOpen={confirming !== null} isDismissable onOpenChange={(o) => { if (!o) setConfirming(null) }}>
        <Modal className="modal">{confirming && <ConfirmRetention next={confirming.next} mode={confirming.mode} onClose={() => setConfirming(null)} onSaved={done}
          onRan={() => { setConfirming(null); void load() }} />}</Modal>
      </ModalOverlay>
    </section>
  )
}
