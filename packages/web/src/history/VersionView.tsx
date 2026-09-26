// A version of a note, in the main area and read-only: its source text (in
// the editor's fonts) with the word diff inline against the previous version
// or the current note, «change N of M» to go through the changes, and
// «Restore this version», asked first because it replaces the text for
// everyone who has the note open (D-033). It is in the URL
// (`?note=…&version=<id>`), so a link opens it and the back button closes it.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay, ToggleButton, ToggleButtonGroup } from 'react-aria-components'
import type { Doc } from 'yjs'
import { errorText, useT } from '../i18n.tsx'
import { historyApi, type Against, type Diff, type RestoreReport, type Version } from './api.ts'
import { changeGroups, changeText, pathLabel } from './format.ts'
import { Authors, Counts, HistoryIcon, useDates, type VersionsStore } from './ui.tsx'

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

export function VersionView({ path, id, store, exists, session, closeLabel, onClose, onRestored }: {
  path: string
  id: string
  /** The note's versions (the side panel's list, when the note is open). */
  store: VersionsStore
  /** Whether the note is at `path` now; if not, restoring creates it again and there is no «current» to compare with. */
  exists: boolean
  /** The open note's session: comparing with the current text follows what is being typed. */
  session?: { doc: Doc } | null
  closeLabel: string
  onClose: () => void
  onRestored: (report: RestoreReport, path: string) => void
}) {
  const t = useT()
  const dates = useDates()
  const compareLabel = useId()
  const [meta, setMeta] = useState<{ version: Version; older: Version | null } | 'missing' | null>(null)
  const [against, setAgainst] = useState<Against>('previous')
  const [diff, setDiff] = useState<{ key: string; value: Diff } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [cur, setCur] = useState(0)
  const [tick, setTick] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const key = `${path}\n${id}\n${against}`

  // Who made it and when: from the note's list of versions.
  useEffect(() => {
    let live = true
    setMeta(null)
    setConfirming(false)
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
    if (!shown || startedFor.current === key) return
    startedFor.current = key
    setCur(0)
    const first = scroller.current?.querySelector('[data-change="0"]')
    if (first) first.scrollIntoView({ block: 'center' })
    else scroller.current?.scrollTo({ top: 0 })
  }, [shown, key])
  useEffect(() => { if (cur >= count && count > 0) setCur(count - 1) }, [cur, count])

  // Esc goes back to the note, unless it's for something on top (a dialog, the overlaid panel, the palette).
  const close = useRef(onClose)
  close.current = onClose
  const asking = useRef(confirming)
  asking.current = confirming
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
  const mark = version ? changeText(t, version, dates.dateTime) : null
  const insLabels = { start: t('version.insStart'), end: t('version.insEnd') }
  const delLabels = { start: t('version.delStart'), end: t('version.delEnd') }

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
          {exists && (
            <div className="v-compare">
              <span id={compareLabel} className="v-compare-label">{t('version.compare')}</span>
              <ToggleButtonGroup className="v-seg" aria-labelledby={compareLabel} selectionMode="single" disallowEmptySelection selectedKeys={[against]}
                onSelectionChange={(keys) => { const k = [...keys][0]; if (k === 'previous' || k === 'current') setAgainst(k) }}>
                <ToggleButton id="previous" className="v-seg-btn">{t('version.previous')}</ToggleButton>
                <ToggleButton id="current" className="v-seg-btn">{t('version.current')}</ToggleButton>
              </ToggleButtonGroup>
            </div>
          )}
          {shown && <Counts added={shown.added} removed={shown.removed} />}
          {shown && (count > 0 ? (
            <span className="v-nav">
              <Button className="btn btn-icon btn-quiet" aria-label={t('version.prevChange')} isDisabled={cur <= 0} onPress={() => go(cur - 1)}>{HistoryIcon.up}</Button>
              <span className="v-nav-label" aria-live="polite">{t('version.changeN', { n: cur + 1, total: count })}</span>
              <Button className="btn btn-icon btn-quiet" aria-label={t('version.nextChange')} isDisabled={cur >= count - 1} onPress={() => go(cur + 1)}>{HistoryIcon.down}</Button>
            </span>
          ) : (
            <span className="v-nav-label">{t(against === 'current' ? 'version.sameAsCurrent' : 'version.noChanges')}</span>
          ))}
          <span className="spacer" />
          <span className="v-actions">
            <Button className="btn btn-primary" isDisabled={!restoreId} onPress={() => { setRestoreError(null); setConfirming(true) }}>{restoreLabel}</Button>
            <Button className="btn" onPress={onClose}>{closeLabel}</Button>
          </span>
        </div>
      </header>
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
    </section>
  )
}
