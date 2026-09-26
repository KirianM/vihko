// A version of a note, in the main area and read-only: its source text (in
// the editor's fonts) with the word diff inline against the previous version
// or the current note, «change N of M» to go through the changes, and
// «Restore this version», asked first because it replaces the text for
// everyone who has the note open (D-033). «Revert this change» undoes only
// what this version changed, on the note as it is now, with a preview of what
// is undone and what isn't because it was changed afterwards (D-034.1).
// «Changes | Content only» shows the version's text without marks, to copy
// from. It is in the URL (`?note=…&version=<id>`), so a link opens it and the
// back button closes it.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay, ToggleButton, ToggleButtonGroup } from 'react-aria-components'
import type { Doc } from 'yjs'
import { errorText, useT } from '../i18n.tsx'
import { historyApi, type Against, type Diff, type RestoreReport, type RevertReport, type SkippedPiece, type Version } from './api.ts'
import { changeGroups, changeText, pathLabel } from './format.ts'
import { Authors, Counts, HistoryIcon, snippet, useDates, type VersionsStore } from './ui.tsx'

/** Line breaks of an edit that is only line breaks can't be seen: each gets a visible mark. */
function breaks(text: string): ReactNode {
  return text.split('\n').map((part, i, all) => (
    <Fragment key={i}>{part}{i < all.length - 1 && <><span className="v-nl" aria-hidden="true">↵</span>{'\n'}</>}</Fragment>
  ))
}

/**
 * An edit, marked. The line breaks at its ends stay outside the mark: the
 * text is the same, and the mark (and the current change's outline) hugs what
 * can be seen.
 */
function Edit({ op, text, change, current, labels }: { op: 1 | -1; text: string; change: number; current: boolean; labels: { start: string; end: string } }) {
  const Tag = op === 1 ? 'ins' : 'del'
  const props = { 'data-change': change, className: current ? 'v-cur' : undefined, 'data-start': labels.start, 'data-end': labels.end }
  if (!/\S/.test(text)) return <Tag {...props}>{text.includes('\n') ? breaks(text) : text}</Tag>
  const [, before, core, after] = /^(\n*)([\s\S]*?)(\n*)$/.exec(text)!
  return <>{before}<Tag {...props}>{core}</Tag>{after}</>
}

type Show = 'changes' | 'content'

export function VersionView({ path, id, store, exists, session, closeLabel, onClose, onRestored, onReverted }: {
  path: string
  id: string
  /** The note's versions (the side panel's list, when the note is open). */
  store: VersionsStore
  /** Whether the note is at `path` now; if not, restoring creates it again and there is no «current» to compare with (nor to revert on). */
  exists: boolean
  /** The open note's session: comparing with the current text follows what is being typed. */
  session?: { doc: Doc } | null
  closeLabel: string
  onClose: () => void
  onRestored: (report: RestoreReport, path: string) => void
  /** A change was reverted: the notice, with what couldn't be undone. Without it, there is no «Revert this change». */
  onReverted?: (report: RevertReport) => void
}) {
  const t = useT()
  const dates = useDates()
  const compareLabel = useId()
  const showLabel = useId()
  const [meta, setMeta] = useState<{ version: Version; older: Version | null } | 'missing' | null>(null)
  const [against, setAgainst] = useState<Against>('previous')
  const [show, setShow] = useState<Show>('changes')
  const [diff, setDiff] = useState<{ key: string; value: Diff } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [cur, setCur] = useState(0)
  const [tick, setTick] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const key = `${path}\n${id}\n${against}`

  // Who made it and when: from the note's list of versions.
  useEffect(() => {
    let live = true
    setMeta(null)
    setConfirming(false)
    setReverting(false)
    store.find(id).then((r) => { if (live) setMeta(r ?? 'missing') }, () => { if (live) setMeta('missing') })
    return () => { live = false }
  }, [id, store.find]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true
    setError(null)
    historyApi.diff(path, id, against).then((value) => { if (live) setDiff({ key, value }) }, (e) => { if (live) setError(e) })
    return () => { live = false }
  }, [path, id, against, key, tick])

  // Compared with the current note, the diff follows what is being typed.
  useEffect(() => {
    const doc = session?.doc
    if (!doc || against !== 'current') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const on = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setTick((n) => n + 1), 1000)
    }
    doc.on('update', on)
    return () => { doc.off('update', on); if (timer) clearTimeout(timer) }
  }, [session, against])

  const shown = diff?.key === key ? diff.value : null
  const { group, count } = useMemo(() => changeGroups(shown?.ops ?? []), [shown])

  const go = (n: number) => {
    setCur(n)
    scroller.current?.querySelector(`[data-change="${n}"]`)?.scrollIntoView({ block: 'center' })
  }
  // A new version or comparison starts at its first change.
  const startedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!shown || startedFor.current === key || show !== 'changes') return
    startedFor.current = key
    setCur(0)
    const first = scroller.current?.querySelector('[data-change="0"]')
    if (first) first.scrollIntoView({ block: 'center' })
    else scroller.current?.scrollTo({ top: 0 })
  }, [shown, key, show])
  useEffect(() => { if (cur >= count && count > 0) setCur(count - 1) }, [cur, count])

  // Esc goes back to the note, unless it's for something on top (a dialog, the overlaid panel, the palette).
  const close = useRef(onClose)
  close.current = onClose
  const asking = useRef(confirming || reverting)
  asking.current = confirming || reverting
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || asking.current) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('[role="dialog"], [role="alertdialog"], .panel-overlay, .palette-overlay, .drawer-overlay')) return
      e.preventDefault()
      close.current()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const version = meta && meta !== 'missing' ? meta.version : null
  const deleted = version?.change === 'deleted'
  // A version that deletes the note has no text: restoring brings back the one before it.
  const restoreId = meta === 'missing' ? id : deleted ? meta?.older?.id ?? null : version?.id ?? null
  const restoreLabel = t(deleted ? 'version.restoreBefore' : 'version.restore')
  // Reverting undoes a change to the text: a creation is undone by deleting
  // the note, and a deletion by «Restore it as it was before».
  const revertable = exists && !!onReverted && !!version && version.change !== 'created' && version.change !== 'deleted'
  const mark = version ? changeText(t, version, dates.dateTime) : null
  const insLabels = { start: t('version.insStart'), end: t('version.insEnd') }
  const delLabels = { start: t('version.delStart'), end: t('version.delEnd') }

  // «Content only»: the version's text (for a deletion, the text it had), as it is.
  const contentId = deleted ? meta && meta !== 'missing' ? meta.older?.id ?? null : null : id
  const [content, setContent] = useState<{ key: string; text: string | null } | null>(null)
  const contentKey = `${path}\n${contentId}`
  useEffect(() => {
    if (show !== 'content' || meta === null || content?.key === contentKey) return
    let live = true
    if (contentId === null) { setContent({ key: contentKey, text: null }); return }
    historyApi.version(path, contentId).then((v) => { if (live) setContent({ key: contentKey, text: v.text }) }, (e) => { if (live) setError(e) })
    return () => { live = false }
  }, [show, path, contentId, contentKey, meta, content?.key])
  const plain = content?.key === contentKey ? content : null

  const restore = async () => {
    if (!restoreId) return
    setBusy(true)
    setRestoreError(null)
    try {
      const r = await historyApi.restore(path, restoreId)
      setConfirming(false)
      onRestored(r, path)
    } catch (e) {
      setRestoreError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="version" aria-labelledby={`${compareLabel}-title`}>
      <header className="v-band">
        <div className="v-head">
          <h2 className="v-title" id={`${compareLabel}-title`}>{version ? t('version.title', { date: dates.dateTime(version.at) }) : t('version.titlePlain')}</h2>
          {version && <Authors authors={version.authors} reason={version.reason} foundAtStartup={version.foundAtStartup} />}
          {mark && <span className="h-mark">{mark}</span>}
        </div>
        {!exists && <p className="v-notice">{t('version.missingNote', { path: pathLabel(path) })}</p>}
        {deleted && <p className="v-notice">{t('version.deleted')}</p>}
        <div className="v-tools">
          <div className="v-compare">
            <span id={showLabel} className="v-compare-label">{t('version.show')}</span>
            <ToggleButtonGroup className="v-seg" aria-labelledby={showLabel} selectionMode="single" disallowEmptySelection selectedKeys={[show]}
              onSelectionChange={(keys) => { const k = [...keys][0]; if (k === 'changes' || k === 'content') setShow(k) }}>
              <ToggleButton id="changes" className="v-seg-btn">{t('version.showChanges')}</ToggleButton>
              <ToggleButton id="content" className="v-seg-btn">{t('version.showContent')}</ToggleButton>
            </ToggleButtonGroup>
          </div>
          {exists && show === 'changes' && (
            <div className="v-compare">
              <span id={compareLabel} className="v-compare-label">{t('version.compare')}</span>
              <ToggleButtonGroup className="v-seg" aria-labelledby={compareLabel} selectionMode="single" disallowEmptySelection selectedKeys={[against]}
                onSelectionChange={(keys) => { const k = [...keys][0]; if (k === 'previous' || k === 'current') setAgainst(k) }}>
                <ToggleButton id="previous" className="v-seg-btn">{t('version.previous')}</ToggleButton>
                <ToggleButton id="current" className="v-seg-btn">{t('version.current')}</ToggleButton>
              </ToggleButtonGroup>
            </div>
          )}
          {show === 'changes' && shown && <Counts added={shown.added} removed={shown.removed} />}
          {show === 'changes' && shown && (count > 0 ? (
            <span className="v-nav">
              <Button className="btn btn-icon btn-quiet" aria-label={t('version.prevChange')} isDisabled={cur <= 0} onPress={() => go(cur - 1)}>{HistoryIcon.up}</Button>
              <span className="v-nav-label" aria-live="polite">{t('version.changeN', { n: cur + 1, total: count })}</span>
              <Button className="btn btn-icon btn-quiet" aria-label={t('version.nextChange')} isDisabled={cur >= count - 1} onPress={() => go(cur + 1)}>{HistoryIcon.down}</Button>
            </span>
          ) : (
            <span className="v-nav-label">{t(against === 'current' ? 'version.sameAsCurrent' : 'version.noChanges')}</span>
          ))}
          {show === 'content' && plain?.text && <CopyButton text={plain.text} />}
          <span className="spacer" />
          <span className="v-actions">
            {revertable && <Button className="btn" onPress={() => setReverting(true)}>{t('version.revert')}</Button>}
            <Button className="btn btn-primary" isDisabled={!restoreId} onPress={() => { setRestoreError(null); setConfirming(true) }}>{restoreLabel}</Button>
            <Button className="btn" onPress={onClose}>{closeLabel}</Button>
          </span>
        </div>
      </header>
      {show === 'changes' ? (
        <div className="v-scroll" ref={scroller} role="region" aria-label={t('version.text')} tabIndex={0}>
          {error !== null && !shown && <p className="error-text" role="alert">{(error as { code?: string }).code === 'not_found' ? t('version.notFound') : errorText(t, error)}</p>}
          {!shown && error === null && <p className="v-loading">{t('version.loading')}</p>}
          {shown && (
            <div className="v-text">
              {shown.ops.map(([op, text], i) => (op === 0
                ? <Fragment key={i}>{text}</Fragment>
                : <Edit key={i} op={op} text={text} change={group[i]!} current={group[i] === cur} labels={op === 1 ? insLabels : delLabels} />))}
            </div>
          )}
        </div>
      ) : (
        <div className="v-scroll" role="region" aria-label={t('version.contentText')} tabIndex={0}>
          {error !== null && !plain && <p className="error-text" role="alert">{errorText(t, error)}</p>}
          {!plain && error === null && <p className="v-loading">{t('version.loading')}</p>}
          {plain && (plain.text ? <div className="v-text v-plain">{plain.text}</div> : <p className="v-loading">{t('version.noText')}</p>)}
        </div>
      )}
      <ModalOverlay className="modal-overlay" isOpen={confirming} onOpenChange={(o) => { if (!o && !busy) setConfirming(false) }} isDismissable>
        <Modal className="modal">
          <Dialog className="dialog dialog-narrow" role="alertdialog">
            <div className="dialog-fields">
              <Heading slot="title" className="dialog-title">{t('version.restoreTitle')}</Heading>
              <p className="dialog-text">{exists ? t('version.restoreBody') : t('version.restoreBodyMissing', { path: pathLabel(path) })}</p>
              {restoreError && <p className="error-text" role="alert">{restoreError}</p>}
            </div>
            <div className="dialog-actions">
              <Button className="btn" autoFocus onPress={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button className="btn btn-primary" isDisabled={busy} onPress={() => void restore()}>{restoreLabel}</Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
      {reverting && onReverted && (
        <RevertDialog path={path} id={id} onCancel={() => setReverting(false)} onDone={(r) => { setReverting(false); onReverted(r) }} />
      )}
    </section>
  )
}

/** Copies the version's text: the clipboard API where the page may use it, a selection and `copy` otherwise (plain http). */
function CopyButton({ text }: { text: string }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 4000)
    return () => clearTimeout(timer)
  }, [state])
  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text)
      else if (!copyBySelection(text)) throw new Error('copy refused')
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  return (
    <span className="v-copy">
      <Button className="btn btn-sm" onPress={() => void copy()}>{t('version.copy')}</Button>
      <span className={state === 'failed' ? 'v-copy-state v-copy-failed' : 'v-copy-state'} role="status">
        {state === 'copied' ? t('version.copied') : state === 'failed' ? t('version.copyFailed') : ''}
      </span>
    </span>
  )
}

function copyBySelection(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.className = 'visually-hidden'
  document.body.append(area)
  area.select()
  try {
    return document.execCommand('copy')
  } finally {
    area.remove()
  }
}

/**
 * «Revert this change?»: what will be undone and what won't, and why, asked
 * of the server without writing anything (`dryRun`). The revert itself is
 * worked out again on the note as it is then: the notice after it says what
 * really happened.
 */
function RevertDialog({ path, id, onCancel, onDone }: { path: string; id: string; onCancel: () => void; onDone: (report: RevertReport) => void }) {
  const t = useT()
  const [preview, setPreview] = useState<RevertReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    historyApi.revert(path, id, { dryRun: true }).then((r) => { if (live) setPreview(r) }, (e) => { if (live) setError(errorText(t, e)) })
    return () => { live = false }
  }, [path, id, t])

  const revert = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await historyApi.revert(path, id))
    } catch (e) {
      setError(errorText(t, e))
      setBusy(false)
    }
  }

  const counts = preview?.counts
  const nothing = counts && counts.reverted === 0
  return (
    <ModalOverlay className="modal-overlay" isOpen onOpenChange={(o) => { if (!o && !busy) onCancel() }} isDismissable>
      <Modal className="modal">
        <Dialog className="dialog rv-dialog" role="alertdialog">
          <div className="dialog-fields">
            <Heading slot="title" className="dialog-title">{t('version.revertTitle')}</Heading>
            <p className="dialog-text">{t('version.revertBody')}</p>
            {!preview && !error && <p className="dialog-text rv-loading" role="status">{t('version.revertLoading')}</p>}
            {nothing && (
              <p className="rv-nothing" role="status">
                {t(counts.skipped > 0 ? 'version.revertAllSkipped' : counts.already > 0 ? 'version.revertNothing' : 'version.revertNoChange')}
              </p>
            )}
          </div>
          {preview && counts!.reverted > 0 && (
            <section className="preview" aria-label={t('version.revertWill', { n: counts!.reverted })}>
              <div className="preview-head">{t('version.revertWill', { n: counts!.reverted })}</div>
              <ul className="preview-body rv-list">
                {preview.reverted.map((p, i) => (
                  <li key={i} className="rv-piece">
                    {p.before && <span className="rv-context">{p.before}</span>}
                    {p.removed && <del data-start={t('version.delStart')} data-end={t('version.delEnd')}>{p.removed}</del>}
                    {p.restored && <ins data-start={t('version.insStart')} data-end={t('version.insEnd')}>{p.restored}</ins>}
                    {p.after && <span className="rv-context">{p.after}</span>}
                  </li>
                ))}
                {counts!.reverted > preview.reverted.length && <li className="preview-note">{t('version.revertMore', { n: counts!.reverted - preview.reverted.length })}</li>}
              </ul>
            </section>
          )}
          {preview && counts!.skipped > 0 && (
            <section className="shifts rv-skipped" aria-label={t('version.revertWont', { n: counts!.skipped })}>
              <div className="shifts-head">
                <span className="shifts-icon">{HistoryIcon.history}</span>
                <span>
                  <strong>{t('version.revertWont', { n: counts!.skipped })}</strong>
                  <span className="shifts-hint">{t('version.revertWontHint')}</span>
                </span>
              </div>
              <ul className="rv-list">
                {preview.skipped.map((s, i) => <SkippedRow key={i} piece={s} />)}
                {counts!.skipped > preview.skipped.length && <li>{t('version.revertMore', { n: counts!.skipped - preview.skipped.length })}</li>}
              </ul>
            </section>
          )}
          {error && <p className="error-text dialog-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <Button className="btn" autoFocus onPress={onCancel}>{t('common.cancel')}</Button>
            <Button className="btn btn-primary" isDisabled={busy || !preview || !!nothing} onPress={() => void revert()}>{t('version.revert')}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

function SkippedRow({ piece }: { piece: SkippedPiece }) {
  const t = useT()
  const version = snippet(piece.version, 80)
  const previous = snippet(piece.previous, 80)
  const what = !previous ? t('version.revertAdded', { version }) : !version ? t('version.revertDeleted', { previous }) : t('version.revertChanged', { previous, version })
  return (
    <li className="rv-skip">
      <span>{what}</span>
      {piece.current
        ? <span className="rv-now">{t('version.revertNow')} <span className="rv-piece">{piece.before && <span className="rv-context">{piece.before}</span>}<mark>{piece.current}</mark>{piece.after && <span className="rv-context">{piece.after}</span>}</span></span>
        : <span className="rv-now">{t('version.revertNowGone')}</span>}
    </li>
  )
}
