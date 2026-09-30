// "More actions" for the open note: insert an image, rename or move with a
// preview of the links that get rewritten and the images that go with the
// note, and move to the trash. History (M2) will live in
// this same menu.
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Text, TextField } from 'react-aria-components'
import { api, type MoveJob, type MoveReport } from '../api.ts'
import { AudienceWarning, audienceChanges } from '../Audience.tsx'
import { DestinationFields, joinPlace, splitPlace, usePlaces } from '../Destination.tsx'
import { ShiftPreview } from '../Shifts.tsx'
import { errorText, useT, type MessageKey } from '../i18n.tsx'
import { usePathLabels } from '../spaces.tsx'
import { Icon, noteName } from '../ui.tsx'
import '../actions.css'

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** The server's `exists` for a move: the generic «not available here» (D-056.20), never whether something hidden is there. */
export function moveError(t: ReturnType<typeof useT>, err: unknown): string {
  const code = err instanceof Error && 'code' in err ? String(err.code) : ''
  if (code === 'exists') return t('move.notAvailable')
  return errorText(t, err)
}

/** Destination path from the fields; null without a name. */
function targetPath(name: string, folder: string): string | null {
  const n = name.trim()
  if (!n) return null
  const f = folder.trim().replace(/^\/+|\/+$/g, '')
  const file = /\.md$/i.test(n) ? n : `${n}.md`
  return f ? `${f}/${file}` : file
}

type Preview = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; report: MoveReport } | { kind: 'error'; message: string }

/**
 * Also used from the folder tree; `initialFolder` presets the destination (a
 * drop onto a folder). A move whose links take long to rewrite hands its job
 * to `onStarted` once the note is in place.
 */
export function RenameDialog({ path, initialFolder, onClose, onMoved, onStarted }: {
  path: string
  initialFolder?: string
  onClose: () => void
  onMoved: (to: string, report: MoveReport) => void
  onStarted: (job: MoveJob) => void
}) {
  const t = useT()
  const labels = usePathLabels()
  const label = labels.label
  const places = usePlaces()
  const [name, setName] = useState(noteName(path))
  const start = initialFolder ?? folderOf(path)
  const [dest, setDest] = useState<{ root: string; inner: string } | null>(null)
  // Where it goes: a place (a space, or a folder shared with them) and the folder inside it.
  const { root, inner } = dest ?? splitPlace(places, start)
  const folder = joinPlace(root, inner)
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Moving it changes who sees it: confirmed for this destination (D-038). */
  const [confirmed, setConfirmed] = useState(false)
  const to = targetPath(name, folder)
  const changed = to !== null && to !== path

  // Live preview (dryRun), with a short pause so it is not one request per keystroke.
  useEffect(() => {
    setError(null)
    setConfirmed(false)
    if (!changed) return setPreview({ kind: 'idle' })
    setPreview({ kind: 'loading' })
    let live = true
    const timer = setTimeout(() => {
      api.move(path, to, true)
        .then((report) => { if (live) setPreview({ kind: 'ready', report }) })
        .catch((e) => { if (live) setPreview({ kind: 'error', message: moveError(t, e) }) })
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
  const nothing = !!report && report.relinked.length === 0 && report.shifted.length === 0 && report.kept.length === 0 && report.images.moved.length === 0 && report.images.stayed.length === 0 && !report.images.folder && report.images.failed.length === 0
  const blocked = audienceChanges(report?.audience) && !confirmed

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!report || busy || blocked) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.startMove(path, report.to)
      if ('job' in r) onStarted(r.job)
      else onMoved(r.report.to, r.report)
    } catch (err) {
      setError(moveError(t, err))
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
          <DestinationFields root={root} inner={inner} hint={t('rename.folderHint')}
            onRoot={(r) => setDest({ root: r, inner: '' })} onInner={(i) => setDest({ root, inner: i })} />
        </div>
        <div className="preview" aria-live="polite">
          <div className="preview-head">{t(report?.shifted.length ? 'rename.previewPlain' : 'rename.preview')}</div>
          <div className="preview-body">
            {preview.kind === 'idle' && <span className="preview-note">{t('rename.previewUnchanged')}</span>}
            {preview.kind === 'loading' && <span className="preview-note">{t('rename.previewLoading')}</span>}
            {preview.kind === 'error' && <span className="error-text" role="alert">{preview.message}</span>}
            {report && <AudienceWarning audience={report.audience} confirmed={confirmed} onConfirm={setConfirmed} cross={report.crossSpaceLinks} copied={report.images.copied?.length ?? 0} />}
            {nothing && <span className="preview-note">{t('rename.previewNone')}</span>}
            {report && <ShiftPreview groups={report.shifted} />}
            {report?.relinked.flatMap((r) => r.changes.map((c, i) => (
              <div className="preview-row" key={`${r.path}#${i}`}>
                <span className="preview-src">{label(r.path)}</span>
                <span className="preview-change">
                  <del>{c.before}</del> → <ins>{c.after}</ins>
                </span>
              </div>
            )))}
            {report?.images.copied?.map((img) => (
              <div className="preview-row preview-image" key={`c:${img.from}`}>
                <span className="preview-src">{label(img.from)}</span>
                <span>{t('rename.imageCopied')} <code>{label(img.to)}</code></span>
              </div>
            ))}
            {report?.images.moved.map((img) => (
              <div className="preview-row preview-image" key={`m:${img.from}`}>
                <span className="preview-src">{label(img.from)}</span>
                <span>{t('rename.imageMoves')} <code>{label(img.to)}</code></span>
              </div>
            ))}
            {report?.images.folder && (
              <div className="preview-row preview-image">
                <span className="preview-src">{label(report.images.folder.from)} /</span>
                <span>{t(report.images.folder.files === 1 ? 'rename.folderMovesOne' : 'rename.folderMoves', { n: report.images.folder.files })} <code>{label(report.images.folder.to)} /</code></span>
              </div>
            )}
            {report?.images.failed.map((f) => (
              <div className="preview-row preview-image preview-kept" key={`f:${f.path}`}>
                <span className="preview-src">{label(f.path)}</span>
                <span>{t(f.error === 'not_empty' ? 'rename.folderHasNotes' : 'rename.imageTaken')}</span>
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
          <Button type="submit" className="btn btn-primary" isDisabled={!report || busy || blocked}>{t(submitKey, { n, images })}</Button>
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

export function NoteActions({ path, onMoved, onMoveStarted, onTrashed, onInsertImage }: {
  path: string
  onMoved: (to: string, report: MoveReport) => void
  onMoveStarted: (job: MoveJob) => void
  onTrashed: (id: string) => void
  onInsertImage: () => void
}) {
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
          {open === 'rename' && <RenameDialog path={path} onClose={close} onMoved={(to, r) => { close(); onMoved(to, r) }} onStarted={(job) => { close(); onMoveStarted(job) }} />}
          {open === 'trash' && <TrashDialog path={path} onClose={close} onTrashed={(id) => { close(); onTrashed(id) }} />}
        </Modal>
      </ModalOverlay>
    </>
  )
}
