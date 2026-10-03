// «Trash» (`?view=trash`): what was deleted where the person edits (since
// they could read there), and the shared spaces deleted whole that they may
// restore, newest first: each with its name, where it was (as the UI names
// places), who deleted it and when, what it takes and, with the admin's
// retention on, when it goes. Restoring is for whoever sees it; a note whose
// name was taken meanwhile comes back under another name, or somewhere else.
// Deleting for good (one, or emptying what they may) is for whoever manages
// where it was, a personal space's owner, or who managed a deleted space:
// asked first, and confirmed at the moment as other irreversible actions are
// (nothing is asked while a confirmation of this browser session lasts).
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, Modal, ModalOverlay, TextField } from 'react-aria-components'
import { normKey } from '@vihko/core/resolve'
import { ApiError, api, type DeletedBy, type TrashEmptied, type TrashListed, type TrashSpace, type TrashView } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { SearchButton } from './Palette.tsx'
import { BackButton, Icon, MenuButton, ThemeToggle, noteName, useBytes } from './ui.tsx'
import { useDates } from './history/ui.tsx'
import { usePathLabels } from './spaces.tsx'
import { DestinationFields, joinPlace, splitPlace, usePlaces } from './Destination.tsx'
import { ConfirmField, codeError, confirmReady, useConfirmWith } from './TwoFactor.tsx'
import './trash.css'

/** One line of the list: an entry, or a deleted space as a whole. */
type Item = { kind: 'entry'; id: string; entry: TrashListed } | { kind: 'space'; id: string; space: TrashSpace }

/** A note, as a page with lines. */
const NOTE_ICON = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></svg>

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** The note path a name typed in a folder names (`.md` added); null without a name. */
function notePath(name: string, folder: string): string | null {
  const n = name.trim()
  if (!n || n.includes('/')) return null
  return `${folder ? `${folder}/` : ''}${/\.md$/i.test(n) ? n : `${n}.md`}`
}

function useItemText() {
  const t = useT()
  const labels = usePathLabels()
  return useMemo(() => ({
    name: (it: Item) => it.kind === 'space' ? it.space.name
      : it.entry.kind === 'files' ? t(it.entry.files?.length === 1 ? 'trash.filesOne' : 'trash.files', { n: it.entry.files?.length ?? 0 })
      : noteName(it.entry.path),
    where: (it: Item) => it.kind === 'space' ? t('trash.wholeSpace') : it.entry.kind === 'files' ? labels.label(it.entry.path) : labels.where(it.entry.path, true),
    by: (it: Item) => it.kind === 'space' ? it.space.by : byName(t, it.entry.deletedBy),
    root: (it: Item) => it.kind === 'space' ? it.space.path : it.entry.space,
    at: (it: Item) => it.kind === 'space' ? it.space.deletedAt : it.entry.deletedAt,
  }), [t, labels])
}

function byName(t: ReturnType<typeof useT>, by: DeletedBy): string {
  if (by.kind === 'agent') return t('history.agent', { name: by.name, user: by.onBehalfOf.name })
  if (by.kind === 'system') return t('history.system')
  return by.name
}

export function TrashPage({ onOpen, onChanged, onUnauthorized }: {
  onOpen: (path: string) => void
  /** Something came back, or went for good: the tree may have changed. */
  onChanged: () => void
  onUnauthorized: () => void
}) {
  const t = useT()
  const bytes = useBytes()
  const dates = useDates()
  const labels = usePathLabels()
  const text = useItemText()
  const searchId = useId()
  const spaceId = useId()
  const [view, setView] = useState<TrashView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [chosen, setSpace] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  /** What the last action did, said once at the top; with the note to open, when one came back. */
  const [done, setDone] = useState<{ text: string; open?: string } | null>(null)
  const [discarding, setDiscarding] = useState<Item | null>(null)
  const [emptying, setEmptying] = useState(false)
  const [taken, setTaken] = useState<TrashListed | null>(null)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }

  useEffect(() => {
    let live = true
    api.trashView().then((v) => { if (live) { setView(v); setError(null) } }, (e) => { if (live) fail(e) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload])
  const changed = () => { setReload((n) => n + 1); onChanged() }

  /** Every line: a deleted space's entries go with it, as one. Newest first. */
  const items = useMemo<Item[]>(() => {
    if (!view) return []
    const all: Item[] = [
      ...view.entries.filter((e) => e.deletedSpace === undefined).map((entry) => ({ kind: 'entry' as const, id: entry.id, entry })),
      ...view.spaces.map((s) => ({ kind: 'space' as const, id: s.id, space: s })),
    ]
    return all.sort((a, b) => text.at(b).localeCompare(text.at(a)))
  }, [view, text])
  /** The spaces something in the trash was in, by their names. */
  const roots = useMemo(() => {
    const seen = new Map<string, string>()
    for (const it of items) {
      const root = text.root(it)
      if (root && !seen.has(root)) seen.set(root, it.kind === 'space' ? it.space.name : labels.space(`${root}/_`))
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]))
  }, [items, text, labels])
  // A space chosen whose last line went (restored, emptied): every space again.
  const space = roots.length > 1 && roots.some(([r]) => r === chosen) ? chosen : ''
  const q = normKey(query.trim())
  const shown =items.filter((it) => (!space || text.root(it) === space) && (!q || normKey(`${text.name(it)} ${text.where(it)}`).includes(q)))
  const deletable = shown.some((it) => (it.kind === 'space' ? it.space.canDelete : it.entry.canDelete))
  const spaceName = space ? roots.find(([r]) => r === space)?.[1] ?? '' : ''

  const restore = async (it: Item) => {
    setBusy(it.id)
    setDone(null)
    setError(null)
    try {
      if (it.kind === 'space') {
        const r = await api.restoreSpace(it.id)
        setDone({ text: t('spacesAdmin.restoreDone', { name: r.space.name }) })
      } else {
        const r = await api.restore(it.id)
        restoredSaid(it.entry, r)
      }
      changed()
    } catch (err) {
      // Its name was taken meanwhile: another name, or another place.
      if (it.kind === 'entry' && err instanceof ApiError && err.code === 'exists') setTaken(it.entry)
      else fail(err)
    } finally {
      setBusy(null)
    }
  }
  const restoredSaid = (entry: TrashListed, r: { path: string; left: string[] }) => {
    const left = r.left.length > 0 ? ` ${t('trash.someLeft')}` : ''
    if (entry.kind === 'files') setDone({ text: t('trash.restoredFiles', { folder: labels.label(r.path) }) + left })
    else setDone({ text: t('trash.restored', { name: noteName(r.path) }) + left, open: r.path })
  }

  const count = items.length
  return (
    <>
      <header className="main-head">
        <MenuButton />
        <BackButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="trash-page">
        <h1>{t('trash.pageTitle')}</h1>
        <p className="trash-intro">{t('trash.intro')}</p>
        {view && count > 0 && (
          <p className="trash-summary">
            <span>{t(count === 1 ? 'trash.summaryOne' : 'trash.summary', { n: count, size: bytes(view.bytes) })}</span>
            <span className="trash-retention">{view.retentionDays === null ? t('trash.retentionOff') : t(view.retentionDays === 1 ? 'trash.retentionOnOne' : 'trash.retentionOn', { days: view.retentionDays })}</span>
          </p>
        )}
        {done && (
          <p className="trash-done" role="status">
            {done.text}
            {done.open && <> <Button className="trash-open" onPress={() => onOpen(done.open!)}>{t('trash.open')}</Button></>}
          </p>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        {!view && !error && <p className="trash-empty-text">{t('common.loading')}</p>}
        {view && count === 0 && (
          <div className="trash-empty">
            <span className="trash-empty-icon">{Icon.trash}</span>
            <p className="trash-empty-title">{t('trash.empty')}</p>
            <p className="trash-empty-text">{t('trash.emptyHint')}</p>
          </div>
        )}
        {view && count > 0 && (
          <>
            <div className="trash-filters">
              <label className="trash-search" htmlFor={searchId}>
                {Icon.search}
                <input id={searchId} type="search" className="trash-search-input" placeholder={t('trash.search')} aria-label={t('trash.search')} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
              </label>
              {roots.length > 1 && (
                <>
                  <label className="visually-hidden" htmlFor={spaceId}>{t('trash.space')}</label>
                  <select id={spaceId} className="select trash-space" value={space} onChange={(e) => setSpace(e.target.value)}>
                    <option value="">{t('trash.allSpaces')}</option>
                    {roots.map(([root, name]) => <option key={root} value={root}>{name}</option>)}
                  </select>
                </>
              )}
              <span className="spacer" />
              {deletable && (
                <Button className="btn btn-danger trash-empty-btn" onPress={() => setEmptying(true)}>
                  {space ? t('trash.emptySpace', { space: spaceName }) : t('trash.emptyAll')}
                </Button>
              )}
            </div>
            {shown.length === 0 && <p className="trash-empty-text">{t('trash.noMatch')}</p>}
            <ul className="trash-list" aria-label={t('trash.pageTitle')}>
              {shown.map((it) => {
                const name = text.name(it)
                const size = it.kind === 'space' ? it.space.bytes : it.entry.bytes
                const expires = it.kind === 'space' ? it.space.expiresAt : it.entry.expiresAt
                const canDelete = it.kind === 'space' ? it.space.canDelete : it.entry.canDelete
                const meta = [
                  t('trash.deletedBy', { who: text.by(it), when: dates.dateTime(text.at(it)) }),
                  ...(it.kind === 'space' ? [t(it.space.entries === 1 ? 'trash.spaceEntriesOne' : 'trash.spaceEntries', { n: it.space.entries })] : []),
                  ...(size === null ? [] : [bytes(size)]),
                ]
                return (
                  <li key={it.id} className="trash-item">
                    <span className="trash-icon">{it.kind === 'space' ? Icon.people : it.entry.kind === 'files' ? Icon.folder : NOTE_ICON}</span>
                    <div className="trash-text">
                      <span className="trash-name">{name}</span>
                      <span className="trash-where">{text.where(it)}</span>
                      <span className="trash-meta">{meta.join(' · ')}</span>
                      {expires && <span className="trash-expires">{t('trash.expires', { date: dates.dateTime(expires) })}</span>}
                    </div>
                    <div className="trash-actions">
                      <Button className="btn btn-sm" isDisabled={busy !== null} aria-label={t('trash.restoreLabel', { name })} onPress={() => void restore(it)}>
                        {t(it.kind === 'space' ? 'alerts.restoreSpace' : 'trash.restore')}
                      </Button>
                      {canDelete && (
                        <Button className="btn btn-sm btn-quiet trash-delete" isDisabled={busy !== null} aria-label={t('trash.deleteForeverLabel', { name })} onPress={() => { setDone(null); setDiscarding(it) }}>
                          {t('trash.deleteForever')}
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
      {discarding && (
        <DiscardDialog item={discarding} name={text.name(discarding)} onCancel={() => setDiscarding(null)}
          onDone={() => { setDone({ text: t('trash.discarded', { name: text.name(discarding) }) }); setDiscarding(null); changed() }} />
      )}
      {emptying && (
        <EmptyDialog space={space || null} spaceName={spaceName} onCancel={() => setEmptying(false)}
          onDone={(r) => {
            const n = r.entries + r.spaces
            setDone({ text: t(n === 1 ? 'trash.emptiedOne' : 'trash.emptied', { n, size: bytes(r.bytes) }) })
            setEmptying(false)
            changed()
          }} />
      )}
      {taken && (
        <RestoreAsDialog entry={taken} onCancel={() => setTaken(null)}
          onDone={(r) => { restoredSaid(taken, r); setTaken(null); changed() }} />
      )}
    </>
  )
}

/** «Delete … forever?»: one entry, or a deleted space whole. */
function DiscardDialog({ item, name, onCancel, onDone }: { item: Item; name: string; onCancel: () => void; onDone: () => void }) {
  const t = useT()
  const how = useConfirmWith()
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const confirm = how === 'none' ? undefined : secret.trim()
      if (item.kind === 'space') await api.discardSpace(item.id, confirm)
      else await api.discardTrash(item.id, confirm)
      onDone()
    } catch (e) {
      setError(codeError(t, e))
      setBusy(false)
    }
  }
  return (
    <ModalOverlay className="modal-overlay" isOpen onOpenChange={(o) => { if (!o && !busy) onCancel() }} isDismissable={!busy}>
      <Modal className="modal">
        <Dialog className="dialog dialog-narrow" role="alertdialog">
          <form onSubmit={(e) => { e.preventDefault(); if (confirmReady(how, secret) && !busy) void go() }}>
            <div className="dialog-fields">
              <Heading slot="title" className="dialog-title">{t(item.kind === 'space' ? 'trash.discardSpaceTitle' : 'trash.discardTitle', { name })}</Heading>
              <p className="dialog-text">{t(item.kind === 'space' ? 'trash.discardSpaceBody' : 'trash.discardBody')}</p>
              <p className="hint">{t('trash.historyStays')}</p>
              <ConfirmField how={how} value={secret} onChange={setSecret} hint={t('trash.confirmHint')} />
            </div>
            {error && <p className="error-text dialog-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button className="btn" autoFocus isDisabled={busy} onPress={onCancel}>{t('common.cancel')}</Button>
              <Button type="submit" className="btn btn-danger" isDisabled={busy || !confirmReady(how, secret)}>{t('trash.deleteForever')}</Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

/** «Empty the trash?»: what would go (asked of the server first), what stays, and the confirmation. */
function EmptyDialog({ space, spaceName, onCancel, onDone }: { space: string | null; spaceName: string; onCancel: () => void; onDone: (r: TrashEmptied) => void }) {
  const t = useT()
  const bytes = useBytes()
  const how = useConfirmWith()
  const [plan, setPlan] = useState<TrashEmptied | null>(null)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.emptyTrash({ ...(space ? { space } : {}), dryRun: true }).then((r) => { if (live) setPlan(r) }, (e) => { if (live) setError(errorText(t, e)) })
    return () => { live = false }
  }, [space, t])
  const n = plan ? plan.entries + plan.spaces : 0
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await api.emptyTrash({ ...(space ? { space } : {}), confirm: how === 'none' ? undefined : secret.trim() }))
    } catch (e) {
      setError(codeError(t, e))
      setBusy(false)
    }
  }
  return (
    <ModalOverlay className="modal-overlay" isOpen onOpenChange={(o) => { if (!o && !busy) onCancel() }} isDismissable={!busy}>
      <Modal className="modal">
        <Dialog className="dialog dialog-narrow" role="alertdialog">
          <form onSubmit={(e) => { e.preventDefault(); if (n > 0 && confirmReady(how, secret) && !busy) void go() }}>
            <div className="dialog-fields">
              <Heading slot="title" className="dialog-title">{space ? t('trash.emptySpaceTitle', { space: spaceName }) : t('trash.emptyTitle')}</Heading>
              {!plan && !error && <p className="dialog-text" role="status">{t('common.loading')}</p>}
              {plan && n === 0 && <p className="dialog-text" role="status">{t('trash.emptyNothing')}</p>}
              {plan && n > 0 && <p className="dialog-text">{t(n === 1 ? 'trash.emptyBodyOne' : 'trash.emptyBody', { n, size: bytes(plan.bytes) })}</p>}
              {plan && plan.kept > 0 && <p className="hint">{t(plan.kept === 1 ? 'trash.emptyKeptOne' : 'trash.emptyKept', { n: plan.kept })}</p>}
              {plan && n > 0 && <p className="hint">{t('trash.historyStays')}</p>}
              {plan && n > 0 && <ConfirmField how={how} value={secret} onChange={setSecret} hint={t('trash.confirmHint')} />}
            </div>
            {error && <p className="error-text dialog-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button className="btn" autoFocus isDisabled={busy} onPress={onCancel}>{t('common.cancel')}</Button>
              <Button type="submit" className="btn btn-danger" isDisabled={busy || n === 0 || !confirmReady(how, secret)}>{t('trash.emptyConfirm')}</Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

/**
 * A note whose name was taken while it was in the trash: restored under
 * another name («… (restored)» to start with), or somewhere else the person
 * may write. Never over the note that has its name now.
 */
function RestoreAsDialog({ entry, onCancel, onDone }: { entry: TrashListed; onCancel: () => void; onDone: (r: { path: string; left: string[] }) => void }) {
  const t = useT()
  const places = usePlaces()
  const [name, setName] = useState(() => t('trash.restoredName', { name: noteName(entry.path) }))
  const [dest, setDest] = useState<{ root: string; inner: string } | null>(null)
  const [ambiguous, setAmbiguous] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { root, inner } = dest ?? splitPlace(places, folderOf(entry.path))
  const to = notePath(name, joinPlace(root, inner))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!to || busy || ambiguous) return
    setBusy(true)
    setError(null)
    try {
      onDone(await api.restore(entry.id, to))
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }
  return (
    <ModalOverlay className="modal-overlay" isOpen onOpenChange={(o) => { if (!o && !busy) onCancel() }} isDismissable={!busy}>
      <Modal className="modal">
        <Dialog className="dialog">
          <form onSubmit={submit}>
            <div className="dialog-fields">
              <Heading slot="title" className="dialog-title">{t('trash.takenTitle', { name: noteName(entry.path) })}</Heading>
              <p className="dialog-text">{t('trash.takenBody')}</p>
              <TextField className="field" value={name} onChange={(v) => { setName(v); setError(null) }} autoFocus>
                <Label>{t('rename.name')}</Label>
                <Input />
              </TextField>
              <DestinationFields root={root} inner={inner} hint={t('trash.restoreHint')}
                onRoot={(r) => { setDest({ root: r, inner: '' }); setError(null) }} onInner={(i) => { setDest({ root, inner: i }); setError(null) }} onAmbiguous={setAmbiguous} />
            </div>
            {error && <p className="error-text dialog-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button className="btn" isDisabled={busy} onPress={onCancel}>{t('common.cancel')}</Button>
              <Button type="submit" className="btn btn-primary" isDisabled={busy || !to || ambiguous}>{t('trash.restore')}</Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
