// Workspace alerts: what thoth has detected in the notes folder that needs a
// decision. The server gives codes, data and the actions allowed to whoever is
// looking; here they're worded and only those actions are offered.
import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { ApiError, api, type Alert, type MoveJob, type MovedRelinkReport } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { MenuButton, ThemeToggle, noteName as fileName } from './ui.tsx'
import { SearchButton } from './Palette.tsx'
import type { ConfigError } from '@thoth/core/codes'
import { MoveProgress, type JobEnd } from './MoveProgress.tsx'
import { ShiftPreview } from './Shifts.tsx'
import { useDates } from './history/ui.tsx'
import './actions.css'

type ExternalMove = Extract<Alert, { code: 'external_move' }>

const svg = (children: ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{children}</svg>
)
const icons = {
  warn: svg(<><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>),
  copy: svg(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M9 15h6" /></>),
  twin: svg(<><rect x="3" y="4" width="8" height="16" rx="1" /><rect x="13" y="4" width="8" height="16" rx="1" /></>),
  sync: svg(<path d="M16 3h5v5M8 21H3v-5M21 3l-7 7M3 21l7-7" />),
  config: svg(<><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>),
  moved: svg(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" /><path d="M14 3v6h6v3" /><path d="M14 18h7M18 15l3 3-3 3" /></>),
}

/** Changed links in a report, as a total. */
const linkCount = (r: MovedRelinkReport) => r.relinked.reduce((n, x) => n + x.links, 0)

/**
 * «Update links» for notes moved outside thoth (D-031.4): the preview (what a
 * thoth move would have rewritten) and, on confirming, the rewrite itself; a
 * long one hands its job to `onStarted`.
 */
function RelinkDialog({ alert, onClose, onDone, onStarted }: {
  alert: ExternalMove
  onClose: () => void
  onDone: (report: MovedRelinkReport) => void
  onStarted: (job: MoveJob) => void
}) {
  const t = useT()
  const [report, setReport] = useState<MovedRelinkReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api.relinkPreview(alert.id).then((r) => { if (live) setReport(r) }, (e) => { if (live) setError(errorText(t, e)) })
    return () => { live = false }
  }, [alert.id, t])

  const n = report ? linkCount(report) : 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!report || busy || n === 0) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.startRelink(alert.id)
      if ('job' in r) onStarted(r.job)
      else onDone(r.report)
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('relink.title')}</Heading>
          <p className="dialog-text">{t('relink.body')}</p>
        </div>
        <div className="preview" aria-live="polite">
          <div className="preview-head">{t('rename.previewPlain')}</div>
          <div className="preview-body">
            {!report && !error && <span className="preview-note">{t('rename.previewLoading')}</span>}
            {report && n === 0 && report.shifted.length === 0 && <span className="preview-note">{t('relink.none')}</span>}
            {report && <ShiftPreview groups={report.shifted} />}
            {report?.relinked.flatMap((r) => r.changes.map((c, i) => (
              <div className="preview-row" key={`${r.path}#${i}`}>
                <span className="preview-src">{label(r.path)}</span>
                <span className="preview-change"><del>{c.before}</del> → <ins>{c.after}</ins></span>
              </div>
            )))}
          </div>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={!report || busy || n === 0}>{t(n === 1 ? 'relink.submitOne' : 'relink.submitMany', { n })}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** `hogar/Proxy.md` → `hogar / Proxy`, like in the breadcrumbs. */
const noteName = (path: string) => path.replace(/\.md$/i, '').split('/').join(' / ')
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** "hogar/enlaces.md" → "hogar / enlaces", like the header breadcrumbs. */
const label = (path: string) => path.replace(/\.md$/i, '').split('/').join(' / ')

/** Replaces `{key}` placeholders in a translated text with elements (paths in monospace, names in bold). */
function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((chunk, i) => (i % 2 ? <Fragment key={i}>{parts[chunk] ?? `{${chunk}}`}</Fragment> : chunk))
}

export function AlertsPage({ onOpen, onChanged, onUnauthorized }: {
  onOpen: (path: string) => void
  /** After loading or after an action: the alert count, for the sidebar. */
  onChanged: (count: number) => void
  onUnauthorized: () => void
}) {
  const t = useT()
  const dates = useDates()
  const [alerts, setAlerts] = useState<Alert[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copies, setCopies] = useState<Record<string, string>>({})
  /** «Update links»: its dialog, its job if it went on in the background, and how it ended. */
  const [relink, setRelink] = useState<ExternalMove | null>(null)
  const [relinkJob, setRelinkJob] = useState<MoveJob | null>(null)
  const [relinked, setRelinked] = useState<{ ok: boolean; text: string } | null>(null)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }
  const load = () => api.alerts().then((list) => { setAlerts(list); onChanged(list.length) }).catch(fail)

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Runs an action and reloads the alerts, whether it succeeded or not. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (err) { fail(err) }
    await load()
    setBusy(false)
  }

  const toggleCopy = (path: string) => {
    if (path in copies) return setCopies(({ [path]: _, ...rest }) => rest)
    api.conflict(path).then((r) => setCopies((c) => ({ ...c, [path]: r.text }))).catch(fail)
  }

  const relinkDone = (r: MovedRelinkReport) => {
    setRelink(null)
    setRelinkJob(null)
    setRelinked(r.failed.length
      ? { ok: false, text: t('relink.partial', { notes: r.failed.map((f) => fileName(f.path)).join(', ') }) }
      : { ok: true, text: t('relink.done', { n: linkCount(r) }) })
    void load()
  }
  const relinkEnded = (end: JobEnd) => {
    if (end.kind === 'done') return relinkDone(end.report as MovedRelinkReport)
    setRelinkJob(null)
    setRelinked({ ok: false, text: end.kind === 'lost' ? t('job.lost', { name: fileName(relinkJob?.to ?? '') }) : end.message })
    void load()
  }

  const noteLink = (path: string) => (
    <a className="mono" href={`?note=${encodeURIComponent(path)}`} onClick={(e) => { e.preventDefault(); onOpen(path) }}>{path}</a>
  )
  const adminOnly = <span className="alert-hint">{t('alerts.adminOnly')}</span>

  /** thoth.yaml problems: line and key path, then what's wrong. */
  const configList = (list: ConfigError[]) => (
    <ul className="alert-paths alert-config">
      {list.map((e, j) => (
        <li key={j}>
          {(e.line !== null || e.at) && (
            <span className="mono">{[e.line !== null ? t('alerts.configLine', { line: e.line }) : null, e.at].filter(Boolean).join(' · ')}</span>
          )}
          {' '}{t(`config.${e.code}`, { detail: e.detail ?? '' })}
        </li>
      ))}
    </ul>
  )

  function card(a: Alert, i: number) {
    const id = `alert-${i}`
    const key = `${a.code}:${'path' in a ? a.path : 'uid' in a ? a.uid : 'series' in a ? a.series : 'id' in a ? a.id : ''}`
    const frame = (o: { icon: ReactNode; tone?: 'warn' | 'accent'; title: ReactNode; body: ReactNode; extra?: ReactNode; actions: ReactNode }) => (
      <section key={key} className={`alert-card${o.tone === 'warn' ? ' alert-card-warn' : ''}`} aria-labelledby={id}>
        <span className={`alert-icon alert-icon-${o.tone ?? 'muted'}`}>{o.icon}</span>
        <div className="alert-text">
          <h2 id={id}>{o.title}</h2>
          <p>{o.body}</p>
          {o.extra}
        </div>
        {o.actions && <div className="alert-actions">{o.actions}</div>}
      </section>
    )
    switch (a.code) {
      case 'scan_aborted_mass_delete':
      case 'scan_aborted_root_unavailable': {
        const mass = a.code === 'scan_aborted_mass_delete'
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: mass ? t('alerts.massDeleteTitle', { removing: a.removing, total: a.total }) : t('alerts.rootUnavailableTitle'),
          body: t(mass ? 'alerts.massDeleteBody' : 'alerts.rootUnavailableBody'),
          actions: a.actions.length === 0 ? adminOnly : (
            <>
              {a.actions.includes('rescan') && <Button className="btn" isDisabled={busy} onPress={() => act(() => api.rescan())}>{t('alerts.rescan')}</Button>}
              {mass && a.actions.includes('confirm_removal') && (
                <Button className="btn btn-danger" isDisabled={busy} onPress={() => act(() => api.rescan(a.removing))}>{t('alerts.confirmRemoval')}</Button>
              )}
            </>
          ),
        })
      }
      case 'orphaned_note':
        return frame({
          icon: icons.copy,
          tone: 'accent',
          title: t('alerts.orphanTitle', { note: noteName(a.path) }),
          body: t('alerts.orphanBody'),
          actions: a.actions.length === 0 ? adminOnly : (
            <>
              {a.actions.includes('keep_copy') && <Button className="btn btn-primary" isDisabled={busy} onPress={() => act(() => api.orphan(a.path, 'restore'))}>{t('alerts.keepCopy')}</Button>}
              {a.actions.includes('discard_copy') && <Button className="btn" isDisabled={busy} onPress={() => act(() => api.orphan(a.path, 'discard'))}>{t('alerts.discardCopy')}</Button>}
            </>
          ),
        })
      case 'external_move': {
        const one = a.moves.length === 1 ? a.moves[0]! : null
        return frame({
          icon: icons.moved,
          tone: 'accent',
          title: one
            ? rich(t('alerts.movedTitle'), { from: <span className="mono">{one.from}</span>, to: <span className="mono">{one.to}</span> })
            : t('alerts.movedTitleMany', { n: a.moves.length }),
          body: t(a.links === 1 ? 'alerts.movedBodyOne' : 'alerts.movedBody', { n: a.links }),
          extra: !one && (
            <ul className="alert-paths">
              {a.moves.slice(0, 10).map((m) => <li key={m.from}><span className="mono">{m.from}</span> → {noteLink(m.to)}</li>)}
              {a.moves.length > 10 && <li>{t('alerts.movedMore', { n: a.moves.length - 10 })}</li>}
            </ul>
          ),
          actions: (
            <>
              {one && <Button className="btn" onPress={() => onOpen(one.to)}>{t('alerts.openNote')}</Button>}
              {a.actions.includes('update_links') && (
                <Button className="btn btn-primary" isDisabled={busy || relinkJob !== null} onPress={() => { setRelinked(null); setRelink(a) }}>{t('alerts.updateLinks')}</Button>
              )}
            </>
          ),
        })
      }
      case 'uid_conflict':
        return frame({
          icon: icons.twin,
          title: t('alerts.uidTitle', { n: a.paths.length }),
          body: rich(t('alerts.uidBody'), { uid: <span className="mono">{a.uid}</span> }),
          extra: <ul className="alert-paths">{a.paths.map((p) => <li key={p}>{noteLink(p)}</li>)}</ul>,
          actions: null,
        })
      case 'config_invalid':
        return frame({
          icon: icons.config,
          tone: 'warn',
          title: rich(t('alerts.configTitle'), { file: <span className="mono">{a.file}</span> }),
          body: t(a.fallback === 'last_good' ? 'alerts.configLastGood' : 'alerts.configNone'),
          extra: configList(a.errors),
          actions: null,
        })
      case 'config_warnings':
        return frame({
          icon: icons.config,
          title: rich(t('alerts.configWarningsTitle'), { file: <span className="mono">{a.file}</span> }),
          body: t('alerts.configWarningsBody'),
          extra: configList(a.warnings),
          actions: null,
        })
      case 'config_template_missing':
        return frame({
          icon: icons.config,
          title: t('alerts.templateTitle', { series: a.series }),
          body: rich(t('alerts.templateBody'), { template: <span className="mono">{a.template}</span> }),
          actions: null,
        })
      case 'history_unavailable':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.historyUnavailableTitle'),
          body: t('alerts.historyUnavailableBody'),
          extra: a.detail && (
            <details>
              <summary>{t('alerts.historyDetail')}</summary>
              <pre className="alert-copy">{a.detail}</pre>
            </details>
          ),
          actions: null,
        })
      case 'history_files_too_large':
        return frame({
          icon: icons.config,
          title: a.paths.length === 1 ? t('alerts.historyTooLargeTitleOne') : t('alerts.historyTooLargeTitle', { n: a.paths.length }),
          body: t('alerts.historyTooLargeBody', { limit: a.limitMb }),
          extra: (
            <ul className="alert-paths">
              {a.paths.slice(0, 10).map((p) => <li key={p}><span className="mono">{p}</span></li>)}
              {a.paths.length > 10 && <li>{t('alerts.movedMore', { n: a.paths.length - 10 })}</li>}
            </ul>
          ),
          actions: null,
        })
      case 'history_versions_merged':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: a.versions === 1 ? t('alerts.historyMergedTitleOne') : t('alerts.historyMergedTitle', { n: a.versions }),
          body: t('alerts.historyMergedBody', { since: dates.dateTime(a.since) }),
          actions: null,
        })
      case 'history_no_repository':
        return frame({
          icon: icons.config,
          title: t('alerts.historyNoRepoTitle'),
          body: t('alerts.historyNoRepoBody'),
          actions: null,
        })
      case 'integrations_unversioned':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t(a.api && a.mcp ? 'alerts.unversionedTitleBoth' : a.api ? 'alerts.unversionedTitleApi' : 'alerts.unversionedTitleMcp'),
          body: t(a.mode === 'off' ? 'alerts.unversionedBodyOff' : 'alerts.unversionedBodyUnmanaged'),
          actions: null,
        })
      case 'sync_conflict': {
        const shown = a.path in copies
        return frame({
          icon: icons.sync,
          title: t('alerts.syncTitle'),
          body: a.note
            ? rich(t('alerts.syncBody'), { file: <span className="mono">{baseName(a.path)}</span>, note: <b>{noteName(a.note)}</b> })
            : rich(t('alerts.syncBodyAlone'), { file: <span className="mono">{a.path}</span> }),
          extra: shown && <pre className="alert-copy" aria-label={t('alerts.copyLabel')} tabIndex={0}>{copies[a.path]}</pre>,
          actions: (
            <>
              {a.note && <Button className="btn" onPress={() => onOpen(a.note!)}>{t('alerts.openNote')}</Button>}
              <Button className="btn" aria-expanded={shown} onPress={() => toggleCopy(a.path)}>{t(shown ? 'alerts.hideCopy' : 'alerts.showCopy')}</Button>
            </>
          ),
        })
      }
    }
  }

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="alerts-page">
        <h1>{t('alerts.title')}</h1>
        <p className="alerts-intro">{t('alerts.intro')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        {relinked && <p className={relinked.ok ? 'alerts-done' : 'error-text'} role={relinked.ok ? 'status' : 'alert'}>{relinked.text}</p>}
        {alerts === null
          ? !error && <p className="alerts-empty">{t('common.loading')}</p>
          : alerts.length === 0
            ? <p className="alerts-empty">{t('alerts.empty')}</p>
            : alerts.map(card)}
      </div>
      <ModalOverlay className="modal-overlay" isOpen={relink !== null} onOpenChange={(o) => { if (!o) setRelink(null) }} isDismissable>
        <Modal className="modal">
          {relink && (
            <RelinkDialog alert={relink} onClose={() => setRelink(null)} onDone={relinkDone}
              onStarted={(job) => { setRelink(null); setRelinkJob(job) }} />
          )}
        </Modal>
      </ModalOverlay>
      {relinkJob && <MoveProgress key={relinkJob.id} job={relinkJob} onFinished={relinkEnded} />}
    </>
  )
}
