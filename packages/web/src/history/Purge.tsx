// Purging from the history: a note, or one of its versions, by whoever
// manages its folder; any path by its name (a note or a folder), by the vihko
// admin from «Recent changes», who needn't be able to read it. The confirmation lists what is lost
// (the versions, by date; never their content) and says it can't be undone;
// the server works it out without changing anything first (`dryRun`). The
// admin is told who purged what, and so is whoever wrote in it.
// The admin purging something they can't read confirms at the moment, with
// their code or password (`confirmRequired`).
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, Modal, ModalOverlay, Text, TextField } from 'react-aria-components'
import { errorText, useT } from '../i18n.tsx'
import { ConfirmField, codeError, useConfirmWith } from '../TwoFactor.tsx'
import { normKey } from '@vihko/core/resolve'
import { parseSpacePath } from '@vihko/core/spaces'
import { api } from '../api.ts'
import { CaseChooser } from '../Destination.tsx'
import { everyRoot, rootNamesOf, usePathLabels, useSpaces, type Spaces } from '../spaces.tsx'
import { guessTyped, resolveTyped, typedSegments, type RootNames } from '../typedPath.ts'
import { historyApi, type PurgeableEntry, type PurgeReport } from './api.ts'
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
  const { label: pathLabel } = usePathLabels()
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
  // A path the admin can't read: nothing about it is shown before purging, and the purge is confirmed.
  const hidden = preview?.hidden === true
  const asks = !!preview?.confirmRequired && (n > 0 || hidden)
  return (
    <ModalOverlay className="modal-overlay" isOpen onOpenChange={(o) => { if (!o && !busy) onCancel() }} isDismissable={!busy}>
      <Modal className="modal">
        <Dialog className="dialog dialog-narrow" role="alertdialog">
          <div className="dialog-fields">
            <Heading slot="title" className="dialog-title">{t(version ? 'purge.titleVersion' : 'purge.title', { name: pathLabel(path) })}</Heading>
            <p className="dialog-text">{t(version ? 'purge.bodyVersion' : 'purge.body')}</p>
            {!preview && !error && <p className="dialog-text" role="status">{t('purge.loading')}</p>}
            {preview && n === 0 && !hidden && <p className="dialog-text" role="status">{t('purge.nothing')}</p>}
            {hidden && <p className="dialog-text" role="status">{t('purge.hidden')}</p>}
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
          {preview && (n > 0 || hidden) && (
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
            <Button className="btn btn-danger" isDisabled={busy || !preview || (n === 0 && !hidden) || (asks && !secret.trim())} onPress={() => void purge()}>{t(version ? 'purge.confirmVersion' : 'purge.confirm')}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

/** The purge's notice, once done: what went (and, when nothing had history there, that nothing did; of a path they can't read, neither). */
export function purgedText(t: ReturnType<typeof useT>, r: PurgeReport, pathLabel: (path: string) => string): string {
  // A path they can't read: the same words whether anything there had history or not.
  if (r.hidden) return t('purge.doneHidden', { name: pathLabel(r.path) })
  if (r.versions.length === 0) return t('purge.doneNothing', { name: pathLabel(r.path) })
  return t(r.version ? 'purge.doneVersion' : 'purge.done', { n: r.versions.length, name: pathLabel(r.path) })
}

/** Suggestions shown under the path while typing. */
const SUGGESTED = 8

/** Whether the person reads the space or shared folder a path is in (their own, a space they belong to, a folder shared with them). */
function readsWhere(s: Spaces, path: string): boolean {
  const inside = (root: string) => path === root || path.startsWith(root + '/')
  if (s.info?.personal && inside(s.info.personal.path)) return true
  return (s.info?.spaces ?? []).some((sp) => inside(sp.path)) || (s.info?.shared ?? []).some((sh) => inside(sh.path))
}

/** What a path names, for telling apart choices that read the same: a note, another file, or (without an extension) a folder. */
const kindOf = (path: string): 'note' | 'file' | 'folder' => /\.md$/i.test(path) ? 'note' : /\.[^./]+$/.test(path.slice(path.lastIndexOf('/') + 1)) ? 'file' : 'folder'

/** Every folder above the paths: what the admin may purge whole by its name. */
function withFolders(paths: readonly string[]): string[] {
  const out = new Set(paths)
  for (const p of paths) for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.add(p.slice(0, i))
  return [...out]
}

/**
 * The admin's purge by path (in «Recent changes»): a button that opens a form
 * for a note or a folder, typed as the admin sees it («My notes / diary»,
 * «Home/recipes/Bread»; in any case, typedPath.ts) or picked among what the
 * history holds that they read (deleted notes first), and optionally one
 * version (its id, from «Recent changes» or the command line); then the
 * confirmation. Where the admin reads, the path is found as a link is: one
 * match is used, several that differ only in case are offered, and none is
 * said plainly (nothing has history there). Where they don't read, the space
 * named (by its name, or a person's) and the rest as typed: the admin
 * needn't read it, and the confirmation, the only one, says nothing of what
 * is there. Cancelling the confirmation goes back to the form.
 */
export function AdminPurge({ onPurged }: { onPurged: (report: PurgeReport) => void }) {
  const t = useT()
  const spaces = useSpaces()
  const { label: pathLabel } = usePathLabels()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [asking, setAsking] = useState<{ path: string; version: string | null } | null>(null)
  const [several, setSeveral] = useState<string[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [entries, setEntries] = useState<PurgeableEntry[] | null>(null)
  const [others, setOthers] = useState<RootNames[]>([])

  useEffect(() => {
    if (!open) return
    let live = true
    historyApi.purgeable().then((r) => { if (live) setEntries(r.paths) }, () => { if (live) setEntries([]) })
    // Every space and person, by name: what the admin purges without reading it.
    Promise.all([api.adminSpaces().catch(() => ({ spaces: [] })), api.directory().catch(() => ({ users: [] as string[] }))])
      .then(([sp, dir]) => { if (live) setOthers(everyRoot(sp.spaces, dir.users)) })
    return () => { live = false }
  }, [open])

  const roots = useMemo(() => rootNamesOf(spaces, others), [spaces, others])
  const known = useMemo(() => withFolders((entries ?? []).map((e) => e.path)), [entries])
  const query = normKey(typedSegments(text).join('/'))
  const suggestions = useMemo(() => {
    if (!entries) return []
    const shown = entries.map((e) => ({ ...e, label: pathLabel(e.path) }))
    const hits = query ? shown.filter((e) => normKey(typedSegments(e.label).join('/')).includes(query) || normKey(e.path).includes(query)) : shown.filter((e) => e.deleted)
    return hits.sort((a, b) => Number(b.deleted) - Number(a.deleted) || a.label.localeCompare(b.label)).slice(0, SUGGESTED)
  }, [entries, query, pathLabel])

  const type = (v: string) => { setText(v); setPicked(null); setSeveral(null); setMessage(null) }
  const ask = (path: string) => { setSeveral(null); setMessage(null); setAsking({ path, version: version.trim() || null }) }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    if (picked) return ask(picked)
    const r = resolveTyped(text, known, roots)
    if (r.status === 'one') return ask(r.path)
    if (r.status === 'several') return setSeveral(r.paths)
    const guess = guessTyped(text, roots)
    if (guess === null) return setMessage(t('purge.noSpace', { typed: text.trim() }))
    // Where the admin reads, everything with history is in the list: nothing is, there.
    if (readsWhere(spaces, guess)) return setMessage(t('purge.noHistory', { name: pathLabel(guess) }))
    // Where they don't, by its name: a note or a folder, when its name doesn't say.
    const last = guess.slice(guess.lastIndexOf('/') + 1)
    if (guess.includes('/') && !/\.[^.]+$/.test(last) && parseSpacePath(guess)?.inner) return setSeveral([`${guess}.md`, guess])
    ask(guess)
  }
  const close = () => { setOpen(false); type(''); setVersion('') }
  return (
    <>
      <Button className="btn btn-sm btn-quiet purge-open" onPress={() => setOpen(true)}>{t('purge.adminOpen')}</Button>
      <ModalOverlay className="modal-overlay" isOpen={open && !asking} onOpenChange={(o) => { if (!o) close() }} isDismissable>
        <Modal className="modal">
          <Dialog className="dialog dialog-narrow">
            <form onSubmit={submit}>
              <div className="dialog-fields">
                <Heading slot="title" className="dialog-title">{t('purge.adminTitle')}</Heading>
                <p className="dialog-text">{t('purge.adminIntro')}</p>
                <TextField className="field" value={text} onChange={type} autoFocus>
                  <Label>{t('purge.adminPath')}</Label>
                  <Input placeholder={t('purge.adminPathPlaceholder', { mine: t('spaces.mine') })} autoComplete="off" />
                  <Text slot="description" className="hint">{t('purge.adminPathHint')}</Text>
                </TextField>
                {!picked && !several && suggestions.length > 0 && (
                  <section className="purge-pick" aria-label={t(query ? 'purge.pickMatching' : 'purge.pickDeleted')}>
                    <p className="hint">{t(query ? 'purge.pickMatching' : 'purge.pickDeleted')}</p>
                    <ul className="purge-pick-list">
                      {suggestions.map((s) => (
                        <li key={s.path}>
                          <Button className="btn btn-sm btn-quiet purge-pick-item" onPress={() => { setText(s.label); setPicked(s.path); setSeveral(null); setMessage(null) }}>
                            <span className="purge-pick-name">{s.label}</span>
                            {s.deleted && <span className="purge-pick-deleted">{t('purge.deleted')}</span>}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {several && <CaseChooser paths={several} onChoose={ask} kind={kindOf} />}
                {message && <p className="error-text" role="alert">{message}</p>}
                <TextField className="field" value={version} onChange={setVersion}>
                  <Label>{t('purge.adminVersion')}</Label>
                  <Input className="mono" />
                  <Text slot="description" className="hint">{t('purge.adminVersionHint')}</Text>
                </TextField>
              </div>
              <div className="dialog-actions">
                <Button className="btn" onPress={close}>{t('common.cancel')}</Button>
                <Button type="submit" className="btn btn-danger" isDisabled={!text.trim()}>{t('purge.adminGo')}</Button>
              </div>
            </form>
          </Dialog>
        </Modal>
      </ModalOverlay>
      {asking && (
        <PurgeDialog path={asking.path} version={asking.version} onCancel={() => setAsking(null)}
          onDone={(r) => {
            setAsking(null)
            // Nothing had history there: said in the form, which stays open to try another.
            if (r.versions.length === 0 && !r.hidden) return setMessage(purgedText(t, r, pathLabel))
            close()
            onPurged(r)
          }} />
      )}
    </>
  )
}
