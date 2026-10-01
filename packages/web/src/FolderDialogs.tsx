// Folder dialogs: create, rename or move (with a preview of the links that get
// rewritten across the notes, as for a note) and delete (at once when empty;
// otherwise, what it holds to the trash with it).
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, TextField } from 'react-aria-components'
import { ApiError, api, type FolderContents, type FolderMoveReport, type MoveJob, type TrashEntry } from './api.ts'
import { AudienceWarning, audienceChanges } from './Audience.tsx'
import { DestinationFields, joinPlace, splitPlace, usePlaces } from './Destination.tsx'
import { RelinkRows } from './MovePreview.tsx'
import { ShiftPreview } from './Shifts.tsx'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { parentOf } from './FolderTree.tsx'
import { usePathLabels } from './spaces.tsx'
import './actions.css'

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The server's codes worded for a folder: `exists` (never whether something hidden is there) and `invalid_path` otherwise speak of notes. */
function folderError(t: ReturnType<typeof useT>, err: unknown): string {
  const code = err instanceof Error && 'code' in err ? String(err.code) : ''
  if (code === 'exists') return t('folder.exists')
  if (code === 'invalid_path') return t('folder.invalidPath')
  return errorText(t, err)
}

/** Folder path from a name and a parent; null without a usable name (no slashes, no leading dot). */
export function folderPath(name: string, parent: string): string | null {
  const n = name.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\]/g, '-').trim()
  if (!n || n.startsWith('.')) return null
  const p = parent.trim().replace(/^\/+|\/+$/g, '')
  return p ? `${p}/${n}` : n
}

export function NewFolderDialog({ parent, onClose, onCreated }: { parent: string; onClose: () => void; onCreated: (path: string) => void }) {
  const t = useT()
  const places = usePlaces()
  const [name, setName] = useState('')
  const [dest, setDest] = useState<{ root: string; inner: string } | null>(null)
  const { root, inner } = dest ?? splitPlace(places, parent)
  /** The folder typed names several that differ only in case: not until one is chosen. */
  const [ambiguous, setAmbiguous] = useState(false)
  const where = joinPlace(root, inner)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const path = folderPath(name, where)
  // At a space's root, `people` and `spaces` are what links from the notes root start with.
  const shadows = inner.trim() === '' && /^(people|spaces)$/i.test(name.trim())
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!path || busy || ambiguous) return
    setBusy(true)
    setError(null)
    try {
      onCreated((await api.createFolder(path)).path)
    } catch (err) {
      setError(folderError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('folder.newTitle')}</Heading>
          <TextField className="field" value={name} onChange={setName} autoFocus>
            <Label>{t('folder.name')}</Label>
            <Input />
          </TextField>
          <DestinationFields root={root} inner={inner} hint={t('folder.parentHint')}
            onRoot={(r) => setDest({ root: r, inner: '' })} onInner={(i) => setDest({ root, inner: i })} onAmbiguous={setAmbiguous} />
          {shadows && <p className="hint" role="note">{t('folder.shadowsLinks', { name: name.trim() })}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={!path || busy || ambiguous}>{t('folder.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

type Preview = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; report: FolderMoveReport } | { kind: 'error'; message: string }

/**
 * Renames or moves a folder with everything in it. `initialParent` presets the
 * destination (a drop in the tree); the live preview says which notes go and
 * which links are rewritten.
 */
export function FolderMoveDialog({ path, initialParent, onClose, onMoved, onStarted }: {
  path: string
  initialParent?: string
  onClose: () => void
  onMoved: (report: FolderMoveReport) => void
  /** The folder is in place and its links are still being rewritten. */
  onStarted: (job: MoveJob) => void
}) {
  const t = useT()
  const places = usePlaces()
  const [name, setName] = useState(baseName(path))
  const [dest, setDest] = useState<{ root: string; inner: string } | null>(null)
  // Where it goes: a place (a space, or a folder shared with them) and the folder inside it.
  const { root, inner } = dest ?? splitPlace(places, initialParent ?? parentOf(path))
  /** The folder typed names several that differ only in case: not until one is chosen. */
  const [ambiguous, setAmbiguous] = useState(false)
  const parent = joinPlace(root, inner)
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Moving it changes who sees it: confirmed for this destination. */
  const [confirmed, setConfirmed] = useState(false)
  const to = folderPath(name, parent)
  const changed = to !== null && to !== path

  useEffect(() => {
    setError(null)
    setConfirmed(false)
    if (!changed) return setPreview({ kind: 'idle' })
    setPreview({ kind: 'loading' })
    let live = true
    const timer = setTimeout(() => {
      api.moveFolder(path, to, true)
        .then((report) => { if (live) setPreview({ kind: 'ready', report }) })
        .catch((e) => { if (live) setPreview({ kind: 'error', message: folderError(t, e) }) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [path, to, changed, t])

  const report = preview.kind === 'ready' ? preview.report : null
  const n = report ? report.relinked.reduce((sum, r) => sum + r.links, 0) : 0
  const verb = to !== null && parentOf(to) === parentOf(path) ? 'Rename' : 'Move'
  const submitKey: MessageKey = `folder.submit${verb}${n === 0 ? '' : n === 1 ? 'One' : 'Many'}`
  const notes = report ? t(report.notes.length === 1 ? 'folder.notesOne' : 'folder.notesMany', { n: report.notes.length }) : ''
  const files = report ? t(report.files === 1 ? 'folder.filesOne' : 'folder.filesMany', { n: report.files }) : ''
  const blocked = (audienceChanges(report?.audience) && !confirmed) || ambiguous

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!report || busy || blocked) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.startMoveFolder(path, report.to)
      if ('job' in r) onStarted(r.job)
      else onMoved(r.report)
    } catch (err) {
      setError(folderError(t, err))
      setBusy(false)
    }
  }

  return (
    <Dialog className="dialog">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('folder.moveTitle', { name: baseName(path) })}</Heading>
          <TextField className="field" value={name} onChange={setName} autoFocus>
            <Label>{t('folder.name')}</Label>
            <Input />
          </TextField>
          <DestinationFields root={root} inner={inner} hint={t('folder.parentHintMove')}
            onRoot={(r) => setDest({ root: r, inner: '' })} onInner={(i) => setDest({ root, inner: i })} onAmbiguous={setAmbiguous} />
        </div>
        <div className="preview" aria-live="polite">
          <div className="preview-head">{t(report?.shifted.length ? 'rename.previewPlain' : 'rename.preview')}</div>
          <div className="preview-body">
            {preview.kind === 'idle' && <span className="preview-note">{t('folder.previewUnchanged')}</span>}
            {preview.kind === 'loading' && <span className="preview-note">{t('rename.previewLoading')}</span>}
            {preview.kind === 'error' && <span className="error-text" role="alert">{preview.message}</span>}
            {report && <AudienceWarning audience={report.audience} confirmed={confirmed} onConfirm={setConfirmed} broken={report.brokenLinks} dest={report.to} copied={report.images?.copied.length ?? 0} />}
            {report && <span className="preview-note">{t('folder.previewContents', { notes, files })}</span>}
            {report && report.relinked.length === 0 && report.shifted.length === 0 && <span className="preview-note">{t('folder.previewNone')}</span>}
            {report && <ShiftPreview groups={report.shifted} withoutBreaks={report.brokenLinks !== undefined} />}
            {report && <RelinkRows relinked={report.relinked} />}
          </div>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={!report || busy || blocked}>{t(submitKey, { n })}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/**
 * «Move to a new space»: sharing only adds, so what some of a
 * space's members mustn't see goes to a space of its own. The folder becomes
 * a shared space named as it is (the name can change), whoever moves it its
 * only manager besides what the folder itself was shared with; the preview
 * says who stops seeing it, and the move waits for that to be confirmed.
 */
export function MoveToNewSpaceDialog({ path, onClose, onMoved }: { path: string; onClose: () => void; onMoved: (root: string) => void }) {
  const t = useT()
  const [name, setName] = useState(baseName(path))
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const chosen = name.trim()
  useEffect(() => {
    setError(null)
    setConfirmed(false)
    if (!chosen) return setPreview({ kind: 'idle' })
    setPreview({ kind: 'loading' })
    let live = true
    const timer = setTimeout(() => {
      api.spaceFromFolder(path, chosen, true)
        .then((r) => { if (live) setPreview({ kind: 'ready', report: r.report }) })
        .catch((e) => { if (live) setPreview({ kind: 'error', message: spaceMoveError(t, e) }) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [path, chosen, t])
  const report = preview.kind === 'ready' ? preview.report : null
  const notes = report ? t(report.notes.length === 1 ? 'folder.notesOne' : 'folder.notesMany', { n: report.notes.length }) : ''
  const files = report ? t(report.files === 1 ? 'folder.filesOne' : 'folder.filesMany', { n: report.files }) : ''
  const blocked = audienceChanges(report?.audience) && !confirmed
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!report || busy || blocked || !chosen) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.spaceFromFolder(path, chosen)
      onMoved(r.space!.path)
    } catch (err) {
      setError(spaceMoveError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('folder.toNewSpaceTitle', { name: baseName(path) })}</Heading>
          <p className="dialog-text">{t('folder.toNewSpaceIntro')}</p>
          <TextField className="field" value={name} onChange={setName} maxLength={64} autoFocus isRequired>
            <Label>{t('spaces.name')}</Label>
            <Input autoComplete="off" />
          </TextField>
        </div>
        <div className="preview" aria-live="polite">
          <div className="preview-head">{t('rename.preview')}</div>
          <div className="preview-body">
            {preview.kind === 'loading' && <span className="preview-note">{t('rename.previewLoading')}</span>}
            {preview.kind === 'error' && <span className="error-text" role="alert">{preview.message}</span>}
            {report && <AudienceWarning audience={report.audience} confirmed={confirmed} onConfirm={setConfirmed} broken={report.brokenLinks} dest={report.to} copied={report.images?.copied.length ?? 0} />}
            {report && <span className="preview-note">{t('folder.previewContents', { notes, files })}</span>}
            {report && <ShiftPreview groups={report.shifted} withoutBreaks={report.brokenLinks !== undefined} />}
            {report && <RelinkRows relinked={report.relinked} />}
          </div>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={!report || busy || blocked || !chosen}>{t('folder.toNewSpaceSubmit')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** A new space's name the server refuses says so; the rest, as for a folder. */
function spaceMoveError(t: ReturnType<typeof useT>, err: unknown): string {
  if (err instanceof ApiError && err.code === 'invalid' && typeof err.data?.problem === 'string') return t('spaces.nameInvalid')
  return folderError(t, err)
}

/** The contents a `not_empty` answer carries, if it has them. */
function contentsOf(err: unknown): FolderContents | null {
  if (!(err instanceof ApiError) || err.code !== 'not_empty') return null
  const c = err.data?.contents as FolderContents | undefined
  return c && typeof c === 'object' && c.notes && c.files && c.kept ? c : null
}

/**
 * Deletes a folder. An empty one goes at once; one that holds notes or files
 * shows them (the server's `not_empty` says what), and a second confirmation
 * sends them to the trash with it. What vihko never touches (hidden folders,
 * links) or the person can't edit keeps it: the dialog says so and offers
 * nothing to press.
 */
export function DeleteFolderDialog({ path, onClose, onDeleted }: { path: string; onClose: () => void; onDeleted: (trashed: TrashEntry[]) => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What it holds, once the server said it isn't empty: confirming again sends it to the trash. */
  const [contents, setContents] = useState<FolderContents | null>(null)
  const blocked = contents !== null && contents.kept.total > 0
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      onDeleted((await api.deleteFolder(path, contents !== null)).trashed)
    } catch (err) {
      const c = contentsOf(err)
      if (c) setContents(c)
      else setError(folderError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t('folder.deleteTitle', { name: baseName(path) })}</Heading>
        {contents === null ? <p className="dialog-text">{t('folder.deleteBody')}</p> : <FolderContentsList contents={contents} />}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('common.cancel')}</Button>
        {!blocked && (
          <Button className="btn btn-danger" onPress={() => void confirm()} isDisabled={busy}>{t(contents ? 'folder.deleteTrash' : 'folder.deleteConfirm')}</Button>
        )}
      </div>
    </Dialog>
  )
}

/** What a folder holds, as the delete dialog shows it before sending it to the trash (paths relative to the folder). */
function FolderContentsList({ contents: c }: { contents: FolderContents }) {
  const t = useT()
  const blocked = c.kept.total > 0
  const counts = [
    c.notes.total > 0 ? t(c.notes.total === 1 ? 'folder.notesOne' : 'folder.notesMany', { n: c.notes.total }) : null,
    c.files.total > 0 ? t(c.files.total === 1 ? 'folder.filesOne' : 'folder.filesMany', { n: c.files.total }) : null,
  ].filter((x): x is string => x !== null)
  const what = counts.length === 2 ? t('folder.holdsBoth', { notes: counts[0]!, files: counts[1]! }) : counts[0]
  const list = (l: FolderContents['notes'], label: string) => (
    <ul className="folder-list" aria-label={label}>
      {l.paths.map((p) => <li key={p}>{p}</li>)}
      {l.total > l.paths.length && <li className="folder-list-more">{t('folder.deleteMore', { n: l.total - l.paths.length })}</li>}
    </ul>
  )
  return (
    <>
      {what && <p className="dialog-text">{t(blocked ? 'folder.deleteHolds' : 'folder.deleteHoldsTrash', { what })}</p>}
      {c.notes.total > 0 && list(c.notes, t('folder.deleteNotesList'))}
      {c.files.total > 0 && list(c.files, t('folder.deleteFilesList'))}
      {c.kept.total > 0 && <p className="dialog-text" role="alert">{t('folder.deleteKept')}</p>}
      {c.kept.total > 0 && list(c.kept, t('folder.deleteKeptList'))}
    </>
  )
}
