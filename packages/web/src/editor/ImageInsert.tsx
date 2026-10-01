// Inserting images: files (picked, pasted or dropped) are uploaded and
// stored next to the note; an image URL is either copied by the server or
// linked to its origin. The link goes into the note through the shared Y.Text,
// at the place that was chosen even if someone else writes meanwhile.
import type { EditorView } from '@codemirror/view'
import { markdownDest } from '@vihko/core/images'
import { useState, type FormEvent } from 'react'
import { Button, Dialog, FileTrigger, Heading, Input, Label, Modal, ModalOverlay, TextField } from 'react-aria-components'
import * as Y from 'yjs'
import { ApiError, api } from '../api.ts'
import { errorText, useT } from '../i18n.tsx'
import { Icon } from '../ui.tsx'
import type { Session } from './collab.ts'
import { insertionRange } from './insertAt.ts'
import '../actions.css'

/** Where the link goes: kept as Yjs relative positions, so they follow concurrent edits. */
interface Target { from: Y.RelativePosition; to: Y.RelativePosition }
export type UrlChoice = 'copy' | 'link' | 'text'
export type ImageDialogState = { kind: 'insert'; at: Target } | { kind: 'pasted'; url: string; at: Target } | null

/** A URL as a Markdown destination: only what breaks the link is escaped (existing %XX stay). */
const urlDest = (url: string) => url.replace(/[\s()<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
const imageLink = (dest: string) => `![](${dest})`

export function useImageInsert(path: string, session: Session | null, view: EditorView | null, maxBytes: number) {
  const t = useT()
  const [busy, setBusy] = useState<'upload' | 'download' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<ImageDialogState>(null)

  const target = (from: number, to: number): Target | null => {
    if (!session) return null
    return {
      from: Y.createRelativePositionFromTypeIndex(session.text, from),
      to: Y.createRelativePositionFromTypeIndex(session.text, to, -1),
    }
  }
  /** Where the cursor is (or the end of the note, if the editor isn't there). */
  const here = () => {
    const sel = view?.state.selection.main
    const end = session?.text.length ?? 0
    return target(sel ? sel.from : end, sel ? sel.to : end)
  }

  /**
   * Replaces the target with `text` and returns the new target, right after
   * it. Never inside a link, an image or a comment, which it would break
   * (`insertionRange`): the target may be in one's hidden syntax, or have
   * ended up in one while an image uploaded.
   */
  const place = (at: Target, text: string): Target | null => {
    if (!session) return null
    const { doc, text: ytext } = session
    const abs = (r: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(r, doc)?.index
    let from = abs(at.from) ?? ytext.length
    let to = Math.max(from, abs(at.to) ?? from)
    // The cursor follows the link only if it is still where the image was asked for.
    const sel = view?.state.selection.main
    const follow = sel !== undefined && sel.from === from && sel.to === to
    // The editor's text is the shared one (the syntax tree says where the nodes are).
    if (view && view.state.doc.length === ytext.length) ({ from, to } = insertionRange(view.state, from, to))
    doc.transact(() => {
      if (to > from) ytext.delete(from, to - from)
      ytext.insert(from, text)
    })
    const end = from + text.length
    if (view && follow && end <= view.state.doc.length) view.dispatch({ selection: { anchor: end } })
    return target(end, end)
  }

  const fail = (err: unknown) => { setError(errorText(t, err)); setBusy(null) }

  const insertFiles = async (files: File[], at: Target | null) => {
    if (!at || files.length === 0) return
    setError(null)
    setBusy('upload')
    let next: Target | null = at
    for (const [i, file] of files.entries()) {
      if (maxBytes && file.size > maxBytes) return fail(new ApiError(413, 'too_large', 'too large'))
      try {
        const r = await api.uploadImage(path, file)
        next = next && place(next, imageLink(markdownDest(r.src)) + (i < files.length - 1 ? '\n' : ''))
      } catch (err) {
        return fail(err)
      }
    }
    setBusy(null)
  }

  const insertUrl = async (url: string, choice: UrlChoice, at: Target) => {
    setError(null)
    if (choice === 'text') return void place(at, url)
    if (choice === 'link') return void place(at, imageLink(urlDest(url)))
    setBusy('download')
    try {
      const r = await api.fetchImage(path, url)
      place(at, imageLink(markdownDest(r.src)))
      setBusy(null)
    } catch (err) {
      fail(err)
    }
  }

  return {
    busy,
    error,
    dismissError: () => setError(null),
    dialog,
    closeDialog: () => setDialog(null),
    /** Pasted or dropped files, for the range `from`–`to`. */
    onFiles: (files: File[], from: number, to: number) => void insertFiles(files, target(from, to)),
    /** A pasted image URL: ask what to do with it. */
    onUrl: (url: string, from: number, to: number) => { const at = target(from, to); if (at) setDialog({ kind: 'pasted', url, at }) },
    /** «Insert image»: file picker or URL, at the cursor. */
    openInsert: () => { const at = here(); if (at) setDialog({ kind: 'insert', at }) },
    pickFiles: (files: File[], at: Target) => { setDialog(null); void insertFiles(files, at) },
    chooseUrl: (url: string, choice: UrlChoice, at: Target) => { setDialog(null); void insertUrl(url, choice, at) },
  }
}

export type ImageInsert = ReturnType<typeof useImageInsert>

const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim())

function InsertDialog({ ins, at }: { ins: ImageInsert; at: Target }) {
  const t = useT()
  const [url, setUrl] = useState('')
  const valid = isHttpUrl(url)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) ins.chooseUrl(url.trim(), 'copy', at)
  }
  return (
    <Dialog className="dialog dialog-narrow">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('image.insertTitle')}</Heading>
          <FileTrigger acceptedFileTypes={['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']} allowsMultiple
            onSelect={(list) => { if (list?.length) ins.pickFiles([...list], at) }}>
            <Button className="btn btn-primary image-pick">{Icon.image}{t('image.pickFile')}</Button>
          </FileTrigger>
          <p className="dialog-text image-or">{t('image.orUrl')}</p>
          <TextField className="field" value={url} onChange={setUrl} type="url">
            <Label>{t('image.url')}</Label>
            <Input placeholder="https://…" />
          </TextField>
          <p className="hint">{t('image.urlHint')}</p>
        </div>
        <div className="dialog-actions">
          <Button className="btn" onPress={ins.closeDialog}>{t('common.cancel')}</Button>
          <Button className="btn" isDisabled={!valid} onPress={() => ins.chooseUrl(url.trim(), 'link', at)}>{t('image.link')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={!valid}>{t('image.copy')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

function PastedDialog({ ins, url, at }: { ins: ImageInsert; url: string; at: Target }) {
  const t = useT()
  return (
    <Dialog className="dialog dialog-narrow">
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t('image.pastedTitle')}</Heading>
        <p className="dialog-text image-url">{url}</p>
        <p className="hint">{t('image.urlHint')}</p>
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={() => ins.chooseUrl(url, 'text', at)}>{t('image.asText')}</Button>
        <Button className="btn" onPress={() => ins.chooseUrl(url, 'link', at)}>{t('image.link')}</Button>
        <Button className="btn btn-primary" autoFocus onPress={() => ins.chooseUrl(url, 'copy', at)}>{t('image.copy')}</Button>
      </div>
    </Dialog>
  )
}

/** The dialogs and the progress or error notice of image insertion. */
export function ImageInsertUi({ ins }: { ins: ImageInsert }) {
  const t = useT()
  const d = ins.dialog
  return (
    <>
      <ModalOverlay className="modal-overlay" isOpen={d !== null} onOpenChange={(o) => { if (!o) ins.closeDialog() }} isDismissable>
        <Modal className="modal">
          {d?.kind === 'insert' && <InsertDialog ins={ins} at={d.at} />}
          {d?.kind === 'pasted' && <PastedDialog ins={ins} url={d.url} at={d.at} />}
        </Modal>
      </ModalOverlay>
      {(ins.busy || ins.error) && (
        <div className="toast">
          <span className="toast-icon">{ins.error ? Icon.alert : Icon.image}</span>
          <span className="toast-text" role={ins.error ? 'alert' : 'status'}>
            {ins.error ? <><b>{t('image.failed')}</b><span className="error-text">{ins.error}</span></> : t(ins.busy === 'download' ? 'image.downloading' : 'image.uploading')}
          </span>
          {ins.error && <Button className="btn btn-icon btn-quiet" aria-label={t('trash.dismiss')} onPress={ins.dismissError}>{Icon.close}</Button>}
        </div>
      )}
    </>
  )
}
