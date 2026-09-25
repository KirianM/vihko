// Folder dialogs: create, rename or move (with a preview of the links that get
// rewritten across the notes, as for a note) and delete (only when empty).
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, Text, TextField } from 'react-aria-components'
import { api, type FolderMoveReport } from './api.ts'
import { ShiftPreview } from './Shifts.tsx'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { parentOf } from './FolderTree.tsx'
import './actions.css'

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** "hogar/enlaces.md" → "hogar / enlaces", like the header breadcrumbs. */
const label = (path: string) => path.replace(/\.md$/i, '').split('/').join(' / ')

/** The server's codes worded for a folder: `exists` and `invalid_path` otherwise speak of notes. */
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
  const [name, setName] = useState('')
  const [where, setWhere] = useState(parent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const path = folderPath(name, where)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!path || busy) return
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
          <TextField className="field" value={where} onChange={setWhere}>
            <Label>{t('folder.parent')}</Label>
            <Input />
            <Text slot="description" className="hint">{t('folder.parentHint')}</Text>
          </TextField>
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={!path || busy}>{t('folder.create')}</Button>
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
export function FolderMoveDialog({ path, initialParent, onClose, onMoved }: {
  path: string
  initialParent?: string
  onClose: () => void
  onMoved: (report: FolderMoveReport) => void
}) {
  const t = useT()
  const [name, setName] = useState(baseName(path))
  const [parent, setParent] = useState(initialParent ?? parentOf(path))
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const to = folderPath(name, parent)
  const changed = to !== null && to !== path

  useEffect(() => {
    setError(null)
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

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!report || busy) return
    setBusy(true)
    setError(null)
    try {
      onMoved(await api.moveFolder(path, report.to))
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
          <TextField className="field" value={parent} onChange={setParent}>
            <Label>{t('folder.parent')}</Label>
            <Input />
            <Text slot="description" className="hint">{t('folder.parentHintMove')}</Text>
          </TextField>
        </div>
        <div className="preview" aria-live="polite">
          <div className="preview-head">{t(report?.shifted.length ? 'rename.previewPlain' : 'rename.preview')}</div>
          <div className="preview-body">
            {preview.kind === 'idle' && <span className="preview-note">{t('folder.previewUnchanged')}</span>}
            {preview.kind === 'loading' && <span className="preview-note">{t('rename.previewLoading')}</span>}
            {preview.kind === 'error' && <span className="error-text" role="alert">{preview.message}</span>}
            {report && <span className="preview-note">{t('folder.previewContents', { notes, files })}</span>}
            {report && report.relinked.length === 0 && report.shifted.length === 0 && <span className="preview-note">{t('folder.previewNone')}</span>}
            {report && <ShiftPreview groups={report.shifted} />}
            {report?.relinked.flatMap((r) => r.changes.map((c, i) => (
              <div className="preview-row" key={`${r.path}#${i}`}>
                <span className="preview-src">{label(r.path)}</span>
                <span className="preview-change">
                  <del>{c.before}</del> → <ins>{c.after}</ins>
                </span>
              </div>
            )))}
          </div>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={!report || busy}>{t(submitKey, { n })}</Button>
        </div>
      </form>
    </Dialog>
  )
}

export function DeleteFolderDialog({ path, onClose, onDeleted }: { path: string; onClose: () => void; onDeleted: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteFolder(path)
      onDeleted()
    } catch (err) {
      setError(folderError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t('folder.deleteTitle', { name: baseName(path) })}</Heading>
        <p className="dialog-text">{t('folder.deleteBody')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('common.cancel')}</Button>
        <Button className="btn btn-danger" onPress={() => void confirm()} isDisabled={busy}>{t('folder.deleteConfirm')}</Button>
      </div>
    </Dialog>
  )
}
