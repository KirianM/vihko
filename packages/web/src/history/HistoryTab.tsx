// The «History» tab of the note's side panel: the note's versions by day (in
// the person's timezone), newest first, with who made each one and why; on
// top, what is still being written. Picking one opens it in the main area.
import { useState } from 'react'
import { Button } from 'react-aria-components'
import { errorText, useT } from '../i18n.tsx'
import type { HistoryStatus, PurgeReport } from './api.ts'
import { PurgeDialog, purgedText } from './Purge.tsx'
import { changeText } from './format.ts'
import { Authors, Counts, useDates, type VersionsStore } from './ui.tsx'
import { usePathLabels } from '../spaces.tsx'

/** Why there is no history to show, or why new versions aren't being saved (managed mode keeps listing). */
export function HistoryNotice({ status }: { status: HistoryStatus }) {
  const t = useT()
  const code = status.error?.code
  if (status.mode === 'unmanaged' && status.available) return <p className="h-note">{t('history.unmanagedNote')}</p>
  if (status.available) return null
  if (code === 'history_no_repository') return <p className="h-problem" role="status">{t('history.noRepository')}</p>
  if (status.mode === 'managed') return <p className="h-problem" role="status">{t('history.notRecording')}</p>
  return <p className="h-problem" role="status">{t('history.unavailable')}</p>
}

export function HistoryTab({ store, status, current, onOpen, path, canPurge = false, onPurged }: {
  store: VersionsStore
  status: HistoryStatus
  /** The version open in the main area, if any. */
  current: string | null
  onOpen: (id: string) => void
  /** The note, for purging its history. */
  path?: string
  /** Whoever manages its folder purges its history (managed history only). */
  canPurge?: boolean
  onPurged?: (report: PurgeReport) => void
}) {
  const t = useT()
  const { label: pathLabel } = usePathLabels()
  const dates = useDates()
  const [purging, setPurging] = useState(false)
  const [purged, setPurged] = useState<string | null>(null)
  // Unmanaged without a repository (or not readable yet): nothing to list.
  const readable = status.mode === 'managed' || status.available
  const groups = dates.group(store.versions, (v) => v.at)
  return (
    <div className="panel-scroll h-scroll">
      <HistoryNotice status={status} />
      {readable && (
        <>
          {store.excluded && <p className="h-note" role="status">{t(store.versions.length ? 'history.excludedBefore' : 'history.excluded')}</p>}
          {store.pending && (
            <div className="h-pending" role="status">
              <span className="h-pending-label"><span className="h-pending-dot" aria-hidden="true" />{t('history.pending')}</span>
              <Authors authors={store.pending.authors} />
            </div>
          )}
          {store.error !== null && store.versions.length === 0 && (
            <div className="h-problem" role="alert">
              <span>{errorText(t, store.error)}</span>
              <Button className="btn btn-sm" onPress={store.refresh}>{t('common.retry')}</Button>
            </div>
          )}
          {!store.loaded && store.error === null && <p className="panel-empty">{t('common.loading')}</p>}
          {store.loaded && store.error === null && store.versions.length === 0 && !store.pending && !store.excluded && <p className="panel-empty">{t('history.empty')}</p>}
          {groups.map((g) => (
            <section key={g.key} className="h-day" aria-label={dates.day(g.key)}>
              <h3 className="panel-h">{dates.day(g.key)}</h3>
              <ul className="h-list">
                {g.items.map((v) => {
                  const mark = changeText(t, v, dates.dateTime)
                  return (
                    <li key={v.id}>
                      <Button className="h-row" aria-current={v.id === current ? 'true' : undefined} onPress={() => onOpen(v.id)}>
                        <span className="h-row-head">
                          <time className="h-time" dateTime={v.at}>{dates.time(v.at)}</time>
                          <Counts added={v.added} removed={v.removed} />
                        </span>
                        <Authors authors={v.authors} reason={v.reason} foundAtStartup={v.foundAtStartup} />
                        {mark && <span className="h-mark">{mark}</span>}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          {store.next && (
            <Button className="btn btn-sm h-more" isDisabled={store.loadingMore} onPress={store.loadMore}>{t('history.loadMore')}</Button>
          )}
          {purged && <p className="alerts-done" role="status">{purged}</p>}
          {canPurge && path && status.mode === 'managed' && store.versions.length > 0 && (
            <div className="purge-row">
              <Button className="btn btn-sm btn-quiet purge-open" onPress={() => { setPurged(null); setPurging(true) }}>{t('purge.open')}</Button>
            </div>
          )}
          {purging && path && (
            <PurgeDialog path={path} onCancel={() => setPurging(false)} onDone={(r) => { setPurging(false); setPurged(purgedText(t, r, pathLabel)); onPurged?.(r) }} />
          )}
        </>
      )}
    </div>
  )
}
