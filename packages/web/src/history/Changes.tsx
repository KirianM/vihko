// «Recent changes» (`?view=changes`, D-032.6): what changed across the notes,
// by day, with who did it, why and which files, filterable by author. Read
// only: a note opens at that change, and undoing is done note by note from
// there. Meant for reviewing what an agent did.
import { useEffect, useId, useState } from 'react'
import { Button } from 'react-aria-components'
import { ApiError, type TreeNote } from '../api.ts'
import { errorText, useT } from '../i18n.tsx'
import { SearchButton } from '../Palette.tsx'
import { MenuButton, ThemeToggle } from '../ui.tsx'
import { historyApi, type Change, type ChangeFile, type HistoryAuthor, type HistoryStatus } from './api.ts'
import { changeKindText, filterOptions, isNote, pathLabel, uidOf } from './format.ts'
import { HistoryNotice } from './HistoryTab.tsx'
import { Authors, Counts, HistoryIcon, useDates } from './ui.tsx'

/** Files shown per change before «Show N more». */
const FEW = 6

function ChangeCard({ change, onOpen }: { change: Change; onOpen: (file: ChangeFile, change: Change) => void }) {
  const t = useT()
  const dates = useDates()
  const [all, setAll] = useState(false)
  const files = all ? change.files : change.files.slice(0, FEW)
  // What a person did that isn't an edit (the system's reasons are worded with its mark).
  const r = change.reason
  const why = r?.code === 'restored' && r.at ? t('changes.restoredFrom', { date: dates.dateTime(r.at) }) : r?.code === 'trash_restored' ? t('changes.trashRestored') : null
  return (
    <li className="c-change">
      <div className="c-head">
        <time className="h-time" dateTime={change.at}>{dates.time(change.at)}</time>
        <span className="c-who">
          <Authors authors={change.authors} reason={change.reason} foundAtStartup={change.foundAtStartup} />
          {why && <span className="h-mark">{why}</span>}
        </span>
      </div>
      <ul className="c-files">
        {files.map((f) => (
          <li key={`${f.change}:${f.path}`} className={`c-file c-${f.change}`}>
            <span className="c-kind" title={changeKindText(t, f.change)}>
              {HistoryIcon[f.change]}
              <span className="visually-hidden">{changeKindText(t, f.change)}</span>
            </span>
            <span className="c-name">
              {f.from && <span className="c-from">{pathLabel(f.from)} → </span>}
              {isNote(f.path)
                ? <a href={`?note=${encodeURIComponent(f.path)}&version=${encodeURIComponent(change.id)}`} onClick={(e) => { e.preventDefault(); onOpen(f, change) }}>{pathLabel(f.path)}</a>
                : <span className="c-file-path">{f.path}</span>}
            </span>
            <Counts added={f.added} removed={f.removed} />
          </li>
        ))}
      </ul>
      {change.files.length > FEW && (
        <Button className="btn btn-sm btn-quiet c-toggle" aria-expanded={all} onPress={() => setAll(!all)}>
          {all ? t('changes.less') : t('changes.more', { n: change.files.length - FEW })}
        </Button>
      )}
    </li>
  )
}

export function ChangesPage({ status, notes, onOpenVersion, onUnauthorized }: {
  status: HistoryStatus | null
  /** The notes as they are now, to find where a note that moved since lives. */
  notes: TreeNote[] | null
  onOpenVersion: (path: string, id: string) => void
  onUnauthorized: () => void
}) {
  const t = useT()
  const dates = useDates()
  const filterId = useId()
  const [author, setAuthor] = useState('')
  const [page, setPage] = useState<{ author: string; changes: Change[]; next: string | null } | null>(null)
  const [authors, setAuthors] = useState<HistoryAuthor[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(err)
  }

  useEffect(() => {
    let live = true
    setError(null)
    setPage(null)
    historyApi.changes({ author: author || null }).then((r) => {
      if (!live) return
      setPage({ author, changes: r.changes, next: r.next })
      setAuthors(r.authors)
    }, (e) => { if (live) fail(e) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [author])

  const loadMore = async () => {
    if (!page?.next || busy) return
    setBusy(true)
    try {
      const r = await historyApi.changes({ author: page.author || null, cursor: page.next })
      setPage((p) => (p && p.author === page.author ? { ...p, changes: [...p.changes, ...r.changes.filter((c) => !p.changes.some((x) => x.id === c.id))], next: r.next } : p))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Opens the note at that change. A note that moved since is found by its
   * uid (D-005); one that no longer exists opens on its own, where restoring
   * creates it again.
   */
  const open = async (file: ChangeFile, change: Change) => {
    let path = file.path
    if (notes && !notes.some((n) => n.path === path)) {
      const v = await historyApi.version(path, change.id).catch(() => null)
      const uid = uidOf(v?.text ?? null)
      const now = uid ? notes.find((n) => n.uid === uid) : undefined
      if (now) path = now.path
    }
    onOpenVersion(path, change.id)
  }

  const options = filterOptions(t, authors)
  const groups = page ? dates.group(page.changes, (c) => c.at) : []
  const readable = !status || status.mode === 'managed' || status.available
  return (
    <>
      <header className="main-head">
        <MenuButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="changes-page">
        <h1>{t('changes.title')}</h1>
        <p className="changes-intro">{t('changes.intro')}</p>
        {status && <HistoryNotice status={status} />}
        {readable && (
          <>
            <div className="changes-filter">
              <label htmlFor={filterId}>{t('changes.author')}</label>
              <select id={filterId} className="select" value={author} onChange={(e) => setAuthor(e.target.value)}>
                <option value="">{t('changes.all')}</option>
                {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                {author && !options.some((o) => o.key === author) && <option value={author}>{author}</option>}
              </select>
            </div>
            {error !== null && (
              <p className="error-text" role="alert">{errorText(t, error)}</p>
            )}
            {page === null && error === null && <p className="changes-empty">{t('common.loading')}</p>}
            {page && page.changes.length === 0 && <p className="changes-empty">{t(author ? 'changes.emptyFiltered' : 'changes.empty')}</p>}
            {groups.map((g) => (
              <section key={g.key} className="changes-day" aria-labelledby={`${filterId}-${g.key}`}>
                <h2 id={`${filterId}-${g.key}`}>{dates.day(g.key)}</h2>
                <ul className="changes-list">
                  {g.items.map((c) => <ChangeCard key={c.id} change={c} onOpen={(f, ch) => void open(f, ch)} />)}
                </ul>
              </section>
            ))}
            {page?.next && (
              <Button className="btn changes-more" isDisabled={busy} onPress={() => void loadMore()}>{t('history.loadMore')}</Button>
            )}
          </>
        )}
      </div>
    </>
  )
}
