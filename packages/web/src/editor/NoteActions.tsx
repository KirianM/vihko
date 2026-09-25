// "More actions" for the open note: insert an image, rename or move with a
// preview of the links that get rewritten and the images that go with the
// note, and move to the trash. History (M2) will live in
// this same menu.
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Text, TextField } from 'react-aria-components'
import { api, type MoveReport } from '../api.ts'
import { errorText, useT, type MessageKey } from '../i18n.tsx'
import { Icon, noteName } from '../ui.tsx'
import '../actions.css'

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
/** "hogar/enlaces.md" → "hogar / enlaces", like the header breadcrumbs. */
const label = (path: string) => path.replace(/\.md$/i, '').split('/').join(' / ')

/** Destination path from the fields; null without a name. */
function targetPath(name: string, folder: string): string | null {
  const n = name.trim()
  if (!n) return null
  const f = folder.trim().replace(/^\/+|\/+$/g, '')
  const file = /\.md$/i.test(n) ? n : `${n}.md`
  return f ? `${f}/${file}` : file
}

type Preview = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; report: MoveReport } | { kind: 'error'; message: string }

/** Also used from the folder tree; `initialFolder` presets the destination (a drop onto a folder). */
export function RenameDialog({ path, initialFolder, onClose, onMoved }: { path: string; initialFolder?: string; onClose: () => void; onMoved: (to: string, report: MoveReport) => void }) {
  const t = useT()
  const [name, setName] = useState(noteName(path))
  const [folder, setFolder] = useState(initialFolder ?? folderOf(path))
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const to = targetPath(name, folder)
  const changed = to !== null && to !== path

  // Live preview (dryRun), with a short pause so it is not one request per keystroke.
  useEffect(() => {
    setError(null)
    if (!changed) return setPreview({ kind: 'idle' })
    setPreview({ kind: 'loading' })
    let live = true
    const timer = setTimeout(() => {
      api.move(path, to, true)
        .then((report) => { if (live) setPreview({ kind: 'ready', report }) })
        .catch((e) => { if (live) setPreview({ kind: 'error', message: errorText(t, e) }) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [path, to, changed, t])

  const report = preview.kind === 'ready' ? preview.report : null
  const n = report ? report.relinked.reduce((sum, r) => sum + r.links, 0) : 0
  const m = report ? report.images.moved.length : 0
  // The button says exactly what it will do: rename (if the name changes) or
  // move, how many images go with the note and how many links are updated.
  const verb = to !== null && noteName(to) !== noteName(path) ? 'rename' : 'move'
  const action = verb === 'rename' ? 'submit' : 'move'
  const count = n === 0 ? '' : n === 1 ? 'One' : 'Many'
  const submitKey: MessageKey = `rename.${action}${count}${m ? 'Images' : ''}`
  const images = t(m === 1 ? 'rename.imagesOne' : 'rename.imagesMany', { n: m })
  const nothing = !!report && report.relinked.length === 0 && report.kept.length === 0 && report.images.moved.length === 0 && report.images.stayed.length === 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!report || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.move(path, report.to)
      onMoved(r.to, r)
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }

  return (
    <Dialog className="dialog">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('rename.title', { name: noteName(path) })}</Heading>
          <TextField className="field" value={name} onChange={setName} autoFocus>
            <Label>{t('rename.name')}</Label>
            <Input />
          </TextField>
          <TextField className="field" value={folder} onChange={setFolder}>
            <Label>{t('rename.folder')}</Label>
            <Input />
            <Text slot="description" className="hint">{t('rename.folderHint')}</Text>
          </TextField>
        </div>
        <div className="preview" aria-live="polite">
          <div className="preview-head">{t('rename.preview')}</div>
          <div className="preview-body">
            {preview.kind === 'idle' && <span className="preview-note">{t('rename.previewUnchanged')}</span>}
            {preview.kind === 'loading' && <span className="preview-note">{t('rename.previewLoading')}</span>}
            {preview.kind === 'error' && <span className="error-text" role="alert">{preview.message}</span>}
            {nothing && <span className="preview-note">{t('rename.previewNone')}</span>}
            {report?.relinked.flatMap((r) => r.changes.map((c, i) => (
              <div className="preview-row" key={`${r.path}#${i}`}>
                <span className="preview-src">{label(r.path)}</span>
                <span className="preview-change">
                  <del>{c.before}</del> → <ins>{c.after}</ins>
                </span>
              </div>
            )))}
            {report?.images.moved.map((img) => (
              <div className="preview-row preview-image" key={`m:${img.from}`}>
                <span className="preview-src">{label(img.from)}</span>
                <span>{t('rename.imageMoves')} <code>{label(img.to)}</code></span>
              </div>
            ))}
            {report?.images.stayed.map((img) => (
              <div className="preview-row preview-image preview-kept" key={`s:${img.path}`}>
                <span className="preview-src">{label(img.path)}</span>
                <span>{t(img.reason === 'shared' ? 'rename.imageShared' : 'rename.imageElsewhere')}</span>
              </div>
            ))}
            {report?.kept.map((k, i) => (
              <div className="preview-row preview-kept" key={`k:${k.path}#${i}`}>
                <span className="preview-src">{label(k.path)}</span>
                <span><code>{k.raw}</code> {t(k.via === 'alias' ? 'rename.keptAlias' : 'rename.keptPath')}</span>
              </div>
            ))}
          </div>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={!report || busy}>{t(submitKey, { n, images })}</Button>
        </div>
      </form>
    </Dialog>
  )
}

export function TrashDialog({ path, onClose, onTrashed }: { path: string; onClose: () => void; onTrashed: (id: string) => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      onTrashed((await api.trash(path)).id)
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t('trash.title', { name: noteName(path) })}</Heading>
        <p className="dialog-text">{t('trash.body')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('common.cancel')}</Button>
        <Button className="btn btn-danger" onPress={() => void confirm()} isDisabled={busy}>{t('trash.confirm')}</Button>
      </div>
    </Dialog>
  )
}

export function NoteActions({ path, onMoved, onTrashed, onInsertImage }: { path: string; onMoved: (to: string, report: MoveReport) => void; onTrashed: (id: string) => void; onInsertImage: () => void }) {
  const t = useT()
  const [open, setOpen] = useState<'rename' | 'trash' | null>(null)
  const close = () => setOpen(null)
  return (
    <>
      <MenuTrigger>
        <Button className="btn btn-icon" aria-label={t('note.moreActions')}>{Icon.more}</Button>
        <Popover className="menu-popover" placement="bottom end">
          <Menu className="menu" onAction={(key) => (key === 'image' ? onInsertImage() : setOpen(key as 'rename' | 'trash'))}>
            <MenuItem id="image" className="menu-item">{Icon.image}{t('note.insertImage')}</MenuItem>
            <MenuItem id="rename" className="menu-item">{Icon.rename}{t('note.rename')}</MenuItem>
            <MenuItem id="trash" className="menu-item menu-item-danger">{Icon.trash}{t('note.trash')}</MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      <ModalOverlay className="modal-overlay" isOpen={open !== null} onOpenChange={(o) => { if (!o) close() }} isDismissable>
        <Modal className="modal">
          {open === 'rename' && <RenameDialog path={path} onClose={close} onMoved={(to, r) => { close(); onMoved(to, r) }} />}
          {open === 'trash' && <TrashDialog path={path} onClose={close} onTrashed={(id) => { close(); onTrashed(id) }} />}
        </Modal>
      </ModalOverlay>
    </>
  )
}
