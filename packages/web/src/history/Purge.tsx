// Purging from the history (D-038.9): a note, or one of its versions, by whoever
// manages its folder; any path by its name (a note or a folder), by the vihko
// admin, who needn't be able to read it. The confirmation lists what is lost
// (the versions, by date; never their content) and says it can't be undone;
// the server works it out without changing anything first (`dryRun`). The
// admin is told who purged what, and so is whoever wrote in it (D-040 3.6).
// The admin purging something they can't read confirms at the moment, with
// their code or password (`confirmRequired`).
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, Modal, ModalOverlay, TextField } from 'react-aria-components'
import { errorText, useT } from '../i18n.tsx'
import { ConfirmField, codeError, useConfirmWith } from '../TwoFactor.tsx'
import { historyApi, type PurgeReport } from './api.ts'
import { pathLabel } from './format.ts'
import { useDates } from './ui.tsx'
import './purge.css'

/** Versions listed in the confirmation; the rest are counted. */
const SHOWN = 12

/** The admin's own code (or password), for a purge of something they can't read. */
function IdentityField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
  return <ConfirmField how={useConfirmWith()} value={value} onChange={onChange} hint={t('purge.confirmIdentityHint')} />
}

/** «Purge …?»: what goes, asked of the server without writing; then the purge itself. */
export function PurgeDialog({ path, version, onCancel, onDone }: {
  path: string
  /** One version of the note; without it, its whole history. */
  version?: string | null
  onCancel: () => void
  onDone: (report: PurgeReport) => void
}) {
  const t = useT()
  const dates = useDates()
  const [preview, setPreview] = useState<PurgeReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState('')

  useEffect(() => {
    let live = true
    historyApi.purge(path, { version, dryRun: true }).then((r) => { if (live) setPreview(r) }, (e) => { if (live) setError(errorText(t, e)) })
    return () => { live = false }
  }, [path, version, t])

  const purge = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await historyApi.purge(path, { version, confirm: preview?.confirmRequired ? secret.trim() : undefined }))
    } catch (e) {
      setError(codeError(t, e))
      setBusy(false)
    }
  }

  const n = preview?.versions.length ?? 0
  const asks = !!preview?.confirmRequired && n > 0
  return (
    <ModalOverlay className="modal-overlay" isOpen onOpenChange={(o) => { if (!o && !busy) onCancel() }} isDismissable={!busy}>
      <Modal className="modal">
        <Dialog className="dialog dialog-narrow" role="alertdialog">
          <div className="dialog-fields">
            <Heading slot="title" className="dialog-title">{t(version ? 'purge.titleVersion' : 'purge.title', { name: pathLabel(path) })}</Heading>
            <p className="dialog-text">{t(version ? 'purge.bodyVersion' : 'purge.body')}</p>
            {!preview && !error && <p className="dialog-text" role="status">{t('purge.loading')}</p>}
            {preview && n === 0 && <p className="dialog-text" role="status">{t('purge.nothing')}</p>}
          </div>
          {preview && n > 0 && (
            <section className="preview purge-preview" aria-label={t('purge.lost', { n })}>
              <div className="preview-head">{t('purge.lost', { n })}</div>
              <ul className="preview-body purge-list">
                {preview.versions.slice(-SHOWN).reverse().map((v) => (
                  <li key={v.id}>
                    <time dateTime={v.at}>{dates.dateTime(v.at)}</time>
                    {v.files > 1 && <span className="purge-files">{t('purge.files', { n: v.files })}</span>}
                  </li>
                ))}
                {n > SHOWN && <li className="preview-note">{t('purge.more', { n: n - SHOWN })}</li>}
              </ul>
            </section>
          )}
          {preview && n > 0 && (
            <div className="dialog-fields purge-notes">
              <p className="purge-warn" role="note">{t('purge.cantUndo')}</p>
              {preview.onDisk > 0 && <p className="hint">{t(version ? 'purge.noteStays' : 'purge.onDisk')}</p>}
              {preview.sharedWith.length > 0 && <p className="hint">{t('purge.shared', { paths: preview.sharedWith.map(pathLabel).join(', ') })}</p>}
              {preview.movedFrom.length > 0 && <p className="hint">{t('purge.movedFrom', { paths: preview.movedFrom.map(pathLabel).join(', ') })}</p>}
              <p className="hint">{t('purge.adminTold')}</p>
              {asks && <IdentityField value={secret} onChange={setSecret} />}
            </div>
          )}
          {error && <p className="error-text dialog-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <Button className="btn" autoFocus isDisabled={busy} onPress={onCancel}>{t('common.cancel')}</Button>
            <Button className="btn btn-danger" isDisabled={busy || !preview || n === 0 || (asks && !secret.trim())} onPress={() => void purge()}>{t(version ? 'purge.confirmVersion' : 'purge.confirm')}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

/** The purge's notice, once done: what went. */
export function purgedText(t: ReturnType<typeof useT>, r: PurgeReport): string {
  return t(r.version ? 'purge.doneVersion' : 'purge.done', { n: r.versions.length, name: pathLabel(r.path) })
}

/**
 * The admin's form (in «Users and groups»): any path by its name, a note or a
 * folder, and optionally one version (its id, from «Recent changes» or the
 * command line). The admin needn't read it; the confirmation says what goes
 * by date, never its content.
 */
export function AdminPurge() {
  const t = useT()
  const [path, setPath] = useState('')
  const [version, setVersion] = useState('')
  const [asking, setAsking] = useState<{ path: string; version: string | null } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const p = path.trim().replace(/^\/+|\/+$/g, '')
    if (!p) return
    setDone(null)
    setAsking({ path: p, version: version.trim() || null })
  }
  return (
    <section className="settings-section" aria-labelledby="admin-purge">
      <h2 id="admin-purge">{t('purge.adminTitle')}</h2>
      <p className="hint">{t('purge.adminIntro')}</p>
      <form className="purge-form" onSubmit={submit}>
        <TextField className="field purge-path" value={path} onChange={setPath}>
          <Label>{t('purge.adminPath')}</Label>
          <Input placeholder={t('purge.adminPathPlaceholder')} />
        </TextField>
        <TextField className="field purge-version" value={version} onChange={setVersion}>
          <Label>{t('purge.adminVersion')}</Label>
          <Input className="mono" />
        </TextField>
        <Button type="submit" className="btn btn-danger" isDisabled={!path.trim()}>{t('purge.adminGo')}</Button>
      </form>
      <p className="hint">{t('purge.adminVersionHint')}</p>
      {done && <p className="alerts-done" role="status">{done}</p>}
      {asking && (
        <PurgeDialog path={asking.path} version={asking.version} onCancel={() => setAsking(null)}
          onDone={(r) => { setAsking(null); setDone(purgedText(t, r)); setPath(''); setVersion('') }} />
      )}
    </section>
  )
}
