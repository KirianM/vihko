// Workspace alerts: what vihko has detected in the notes folder that needs a
// decision. The server gives codes, data and the actions allowed to whoever is
// looking; here they're worded and only those actions are offered. Notices
// addressed to the person (M4.1: what the admin did to their account, a purge
// of what they wrote) come with them, each until they dismiss it.
import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { ApiError, api, type Alert, type MoveJob, type MovedRelinkReport } from './api.ts'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { BackButton, Icon, MenuButton, ThemeToggle, noteName as fileName } from './ui.tsx'
import { noteHref, usePathLabels } from './spaces.tsx'
import { addressOf } from '@vihko/core/spaces'
import { SearchButton } from './Palette.tsx'
import type { ConfigError, ConfigMigrationRef } from '@vihko/core/codes'
import { MoveProgress, type JobEnd } from './MoveProgress.tsx'
import { RelinkRows } from './MovePreview.tsx'
import { ShiftPreview } from './Shifts.tsx'
import { useDates } from './history/ui.tsx'
import { historyApi } from './history/api.ts'
import { ConfirmField, codeError, confirmReady, useConfirmWith } from './TwoFactor.tsx'
import './actions.css'

type ExternalMove = Extract<Alert, { code: 'external_move' }>
type Translate = ReturnType<typeof useT>

/** Notices addressed to one person: theirs to dismiss, and said when they come in. */
export type PersonalNotice = Extract<Alert, { code: (typeof NOTICE_CODES)[number] }>
const NOTICE_CODES = [
  'account_changed', 'user_account_changed', 'history_purged_authored', 'links_not_updated', 'space_changed', 'shared_with_you', 'retention_ran', 'settings_migrated',
  'moved_out', 'removed_from', 'space_deleted', 'space_restored', 'space_renamed', 'account_key_added',
] as const
export const isPersonalNotice = (a: Alert): a is PersonalNotice => (NOTICE_CODES as readonly string[]).includes(a.code)

/** A settings file as the UI names places: `vihko.yaml`, `~ana/.vihko/settings.yaml`, `Home/.vihko/settings.yaml`. */
const settingsFileName = (path: string) => addressOf(path) ?? path

type NoticeParts = { by?: string; user?: string; path?: string; to?: string; space?: string; name?: string; owner?: string; from?: string }

/** A notice's title: its text's key, and what goes in it (names; a path or a space only while they can still see it). */
function noticeTitle(a: PersonalNotice): { key: MessageKey; parts: NoticeParts } {
  switch (a.code) {
    case 'moved_out': {
      const name = fileName(a.from)
      if (a.space) return { key: 'alerts.movedOutTo', parts: { by: a.by, name, space: a.space.name ?? '' } }
      if (a.owner && a.owner.normalize('NFC').toLowerCase() !== a.by.normalize('NFC').toLowerCase()) return { key: 'alerts.movedOutToOf', parts: { by: a.by, name, owner: a.owner } }
      return { key: 'alerts.movedOutToTheirs', parts: { by: a.by, name } }
    }
    case 'removed_from': {
      if (a.kind === 'space') return { key: 'alerts.removedFromSpace', parts: { by: a.by, space: a.name ?? '' } }
      if (a.owner && a.owner.normalize('NFC').toLowerCase() !== a.by.normalize('NFC').toLowerCase()) return { key: 'alerts.removedFromFolderOf', parts: { by: a.by, name: a.name ?? '', owner: a.owner } }
      if (a.space) return { key: 'alerts.removedFromFolderIn', parts: { by: a.by, name: a.name ?? '', space: a.space } }
      return { key: 'alerts.removedFromFolder', parts: { by: a.by, name: a.name ?? '' } }
    }
    case 'space_deleted': return { key: 'alerts.spaceWasDeleted', parts: { by: a.by, space: a.name } }
    case 'space_restored': return a.name ? { key: 'alerts.spaceWasRestored', parts: { by: a.by, space: a.name } } : { key: 'alerts.spaceWasRestoredNeutral', parts: { by: a.by } }
    case 'space_renamed': return { key: 'alerts.spaceWasRenamed', parts: { by: a.by, from: a.from, space: a.name ?? '' } }
    case 'account_key_added': return { key: a.kind === 'app' ? 'alerts.appAdded' : 'alerts.keyAdded', parts: { name: a.name } }
    case 'links_not_updated': return { key: 'alerts.linksNotUpdated', parts: {} }
    case 'retention_ran': return { key: a.failed ? 'alerts.retentionFailed' : 'alerts.retentionRan', parts: {} }
    case 'settings_migrated': return { key: 'alerts.settingsMigrated', parts: {} }
    case 'space_changed': {
      const space = a.space?.name ?? undefined
      const known = { by: a.by, ...(a.user ? { user: a.user } : {}), ...(a.to ? { to: a.to } : {}), ...(space ? { space } : {}) }
      switch (a.change) {
        case 'manager_assigned': return { key: space ? 'alerts.spaceManagerAssigned' : 'alerts.spaceManagerAssignedNeutral', parts: known }
        case 'admin_joined': return { key: space ? 'alerts.spaceAdminJoined' : 'alerts.spaceAdminJoinedNeutral', parts: known }
        case 'personal_transferred': return { key: 'alerts.spaceTransferred', parts: known }
        case 'personal_converted': return { key: space ? 'alerts.spaceConverted' : 'alerts.spaceConvertedNeutral', parts: known }
        case 'personal_deleted': return { key: 'alerts.spaceDeleted', parts: known }
      }
    }
    case 'shared_with_you': {
      if (a.path === null) return { key: 'alerts.sharedWithYouNeutral', parts: { by: a.by } }
      if (a.kind === 'space') return { key: 'alerts.addedToSpace', parts: { by: a.by, space: a.name ?? '' } }
      // Whose it is, only when someone else shared it: «sam shared “Trips” with you», never «… · sam’s» after it.
      if (a.owner && a.owner.normalize('NFC').toLowerCase() === a.by.normalize('NFC').toLowerCase()) return { key: 'alerts.sharedFolder', parts: { by: a.by, name: a.name ?? '' } }
      return a.owner
        ? { key: 'alerts.sharedFolderOf', parts: { by: a.by, name: a.name ?? '', owner: a.owner } }
        : { key: 'alerts.sharedFolderIn', parts: { by: a.by, name: a.name ?? '', space: a.space ?? '' } }
    }
    case 'account_changed': return {
      key: a.change === 'reset_link' ? 'alerts.accountResetLink' : a.change === 'two_factor_reset' ? 'alerts.accountTwoFactor' : a.role === 'admin' ? 'alerts.accountPromoted' : 'alerts.accountDemoted',
      parts: { by: a.by },
    }
    case 'user_account_changed': return {
      key: a.change === 'reset_link' ? 'alerts.userResetLink' : a.change === 'two_factor_reset' ? 'alerts.userTwoFactor'
        : a.change === 'invite_link' ? 'alerts.userInviteLink' : a.change === 'disabled' ? 'alerts.userDisabled' : a.change === 'deleted' ? 'alerts.userDeleted'
        : a.role === 'admin' ? 'alerts.userPromoted' : 'alerts.userDemoted',
      parts: { by: a.by, user: a.user },
    }
    case 'history_purged_authored': return a.path === null
      ? { key: a.version ? 'alerts.purgedAuthoredVersionNeutral' : 'alerts.purgedAuthoredNeutral', parts: { by: a.by } }
      : { key: a.version ? 'alerts.purgedAuthoredVersion' : 'alerts.purgedAuthored', parts: { by: a.by, path: a.path } }
  }
}

/** A notice's title as plain text (the toast when one comes in); `where` shows a path as the person sees it. */
export function noticeText(t: Translate, a: PersonalNotice, where: (path: string) => string): string {
  const { key, parts } = noticeTitle(a)
  return t(key, { ...parts, ...(parts.path ? { path: where(parts.path) } : {}) })
}

/** The notices that came in with the session: said at once, kept in «Alerts» until dismissed there. */
export function NoticeToast({ notices, onSee, onDismiss }: { notices: PersonalNotice[]; onSee: () => void; onDismiss: () => void }) {
  const t = useT()
  const labels = usePathLabels()
  return (
    <div className="toast">
      <span className="toast-icon">{Icon.alert}</span>
      <span className="toast-text" role="status">{notices.length === 1 ? noticeText(t, notices[0]!, labels.label) : t('notices.many', { n: notices.length })}</span>
      <Button className="btn" onPress={onSee}>{t('notices.see')}</Button>
      <Button className="btn btn-icon btn-quiet" aria-label={t('common.dismiss')} onPress={onDismiss}>{Icon.close}</Button>
    </div>
  )
}

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
  person: svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  people: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" /></>),
  database: svg(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
}

/** Changed links in a report, as a total. */
const linkCount = (r: MovedRelinkReport) => r.relinked.reduce((n, x) => n + x.links, 0)

/**
 * «Update links» for notes moved outside vihko (never rewritten on its own, the other tool may still be writing): the preview (what a
 * vihko move would have rewritten) and, on confirming, the rewrite itself; a
 * long one hands its job to `onStarted`.
 */
function RelinkDialog({ alert, onClose, onDone, onStarted }: {
  alert: ExternalMove
  onClose: () => void
  onDone: (report: MovedRelinkReport) => void
  onStarted: (job: MoveJob) => void
}) {
  const t = useT()
  const { label } = usePathLabels()
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
            {report && <RelinkRows relinked={report.relinked} />}
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

/** «Restore previous permissions»: what it does, confirmed at the moment with the admin's code or password. */
function RestorePermissionsDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT()
  const how = useConfirmWith()
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !confirmReady(how, secret)) return
    setBusy(true)
    setError(null)
    try {
      await api.restorePermissions(secret.trim())
      onDone()
    } catch (err) {
      setError(codeError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <form onSubmit={(e) => void submit(e)}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('alerts.restorePermissionsTitle')}</Heading>
          <p className="dialog-text">{t('alerts.restorePermissionsBody')}</p>
          <ConfirmField how={how} value={secret} onChange={setSecret} hint={t('alerts.restorePermissionsHint')} />
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !confirmReady(how, secret)}>{t('alerts.restorePermissionsConfirm')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Replaces `{key}` placeholders in a translated text with elements (paths in monospace, names in bold). */
function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((chunk, i) => (i % 2 ? <Fragment key={i}>{parts[chunk] ?? `{${chunk}}`}</Fragment> : chunk))
}

export function AlertsPage({ onOpen, onSpaces, onSettings, onChanged, onUnauthorized }: {
  onOpen: (path: string) => void
  /** The admin's «Spaces» page, where a deleted person's space is decided. */
  onSpaces: () => void
  /** Opens the note settings where a settings alert can be fixed: the person's own (null), or a shared space's. */
  onSettings?: (space: { path: string; name: string } | null) => void
  /** After loading or after an action: the alert count, for the sidebar. */
  onChanged: (count: number) => void
  onUnauthorized: () => void
}) {
  const t = useT()
  const dates = useDates()
  // Paths as the person sees them: the space, its folders and the name.
  const { label } = usePathLabels()
  const noteName = label
  const [alerts, setAlerts] = useState<Alert[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copies, setCopies] = useState<Record<string, string>>({})
  /** «Update links»: its dialog, its job if it went on in the background, and how it ended. */
  const [relink, setRelink] = useState<ExternalMove | null>(null)
  const [relinkJob, setRelinkJob] = useState<MoveJob | null>(null)
  const [relinked, setRelinked] = useState<{ ok: boolean; text: string } | null>(null)
  /** «Restore previous permissions»: its confirmation. */
  const [restoringPermissions, setRestoringPermissions] = useState(false)

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
    <a className="mono" href={noteHref(path)} onClick={(e) => { e.preventDefault(); onOpen(path) }}>{label(path)}</a>
  )
  const mono = (path: string) => <span className="mono">{label(path)}</span>
  const adminOnly = <span className="alert-hint">{t('alerts.adminOnly')}</span>

  /** A settings file's problems (vihko.yaml's, or a space's settings): the file, line and key path, then what's wrong. */
  const configList = (list: ConfigError[], file: string) => (
    <ul className="alert-paths alert-config">
      {list.map((e, j) => (
        <li key={j}>
          {(e.line !== null || e.at) && (
            <span className="mono">{t('alerts.inConfig', { file, at: [e.line !== null ? t('alerts.configLine', { line: e.line }) : null, e.at].filter(Boolean).join(' · ') })}</span>
          )}
          {' '}{t(`config.${e.code}`, { detail: e.detail ?? '' })}
        </li>
      ))}
    </ul>
  )

  /** vihko.yaml's format migrations: each one's id and its line (in English, as the log has it). */
  const migrationList = (list: ConfigMigrationRef[]) => (
    <ul className="alert-paths alert-config">
      {list.map((mg) => <li key={mg.id}><span className="mono">{mg.id}</span> {mg.description}</li>)}
    </ul>
  )

  function card(a: Alert, i: number) {
    const id = `alert-${i}`
    const key = `${a.code}:${'id' in a ? a.id : 'path' in a ? a.path : 'uid' in a ? a.uid : 'series' in a ? a.series : ''}`
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
      case 'note_not_saved':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: a.path ? t('alerts.notSavedTitle', { note: noteName(a.path) }) : t('alerts.notSavedTitleHidden', { space: a.space ? label(a.space) : '' }),
          body: `${t(`editor.cantSave.${a.reason}`)} ${t(a.volume === 'notes' ? 'alerts.notSavedNotes' : 'alerts.notSavedState')}`,
          extra: a.path && <ul className="alert-paths"><li>{noteLink(a.path)}</li></ul>,
          actions: null,
        })
      case 'external_move': {
        const one = a.moves.length === 1 ? a.moves[0]! : null
        return frame({
          icon: icons.moved,
          tone: 'accent',
          title: one
            ? rich(t('alerts.movedTitle'), { from: mono(one.from), to: mono(one.to) })
            : t('alerts.movedTitleMany', { n: a.moves.length }),
          body: t(a.links === 1 ? 'alerts.movedBodyOne' : 'alerts.movedBody', { n: a.links }),
          extra: !one && (
            <ul className="alert-paths">
              {a.moves.slice(0, 10).map((m) => <li key={m.from}>{mono(m.from)} → {noteLink(m.to)}</li>)}
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
          extra: configList(a.errors, a.file),
          actions: null,
        })
      case 'config_warnings':
        return frame({
          icon: icons.config,
          title: rich(t('alerts.configWarningsTitle'), { file: <span className="mono">{a.file}</span> }),
          body: t('alerts.configWarningsBody'),
          extra: configList(a.warnings, a.file),
          actions: null,
        })
      case 'settings_invalid':
        return frame({
          icon: icons.config,
          tone: 'warn',
          title: a.space ? t('alerts.spaceSettingsInvalidTitle', { name: a.space.name }) : t('alerts.settingsInvalidTitle'),
          body: t('alerts.settingsInvalidBody'),
          extra: configList(a.errors, settingsFileName(a.file)),
          // Fixed where they're set: the form writes over wrong values and removes the keys chosen.
          actions: onSettings && <Button className="btn" onPress={() => onSettings(a.space)}>{t(a.space ? 'alerts.openSpaceSettings' : 'alerts.openOwnSettings')}</Button>,
        })
      case 'settings_migrated':
        return frame({
          icon: icons.config,
          title: t('alerts.settingsMigrated'),
          body: rich(t(a.file === null ? 'alerts.settingsMigratedBodyHidden' : a.marked === 1 ? 'alerts.settingsMigratedBodyOne' : 'alerts.settingsMigratedBody', { when: dates.dateTime(a.at), n: a.marked }), { file: a.file === null ? null : <span className="mono">{settingsFileName(a.file)}</span> }),
          extra: a.missing.length > 0 && (<>
            <p className="alert-hint">{t('alerts.settingsMigratedMissing')}</p>
            <ul className="alert-paths">{a.missing.map((f) => <li key={f} className="mono">{f}</li>)}</ul>
          </>),
          actions: <Button className="btn" isDisabled={busy} onPress={() => act(() => api.dismissNotice(a.id))}>{t('alerts.dismiss')}</Button>,
        })
      case 'config_migrated':
        return frame({
          icon: icons.config,
          title: rich(t('alerts.configMigratedTitle'), { file: <span className="mono">{a.file}</span> }),
          body: rich(t('alerts.configMigratedBody'), { when: dates.dateTime(a.at), backup: <span className="mono">{a.backup}</span> }),
          extra: migrationList(a.migrations),
          actions: <Button className="btn" isDisabled={busy} onPress={() => act(() => api.dismissConfigMigration(a.id))}>{t('alerts.dismiss')}</Button>,
        })
      case 'state_migrated':
        return frame({
          icon: icons.database,
          title: rich(t('alerts.stateMigratedTitle'), { file: <span className="mono">{a.file}</span> }),
          body: rich(t('alerts.stateMigratedBody', { from: a.from, to: a.to }), { when: dates.dateTime(a.at), backup: <span className="mono">{a.backup}</span> }),
          actions: <Button className="btn" isDisabled={busy} onPress={() => act(() => api.dismissStateMigration(a.id))}>{t('alerts.dismiss')}</Button>,
        })
      case 'config_migration_failed':
        return frame({
          icon: icons.config,
          tone: 'warn',
          title: rich(t('alerts.configMigrationFailedTitle'), { file: <span className="mono">{a.file}</span> }),
          body: t('alerts.configMigrationFailedBody'),
          extra: (
            <>
              {a.migration && migrationList([a.migration])}
              <details>
                <summary>{t('alerts.historyDetail')}</summary>
                <pre className="alert-copy">{a.detail}</pre>
              </details>
            </>
          ),
          actions: null,
        })
      case 'settings_guide_missing':
        return frame({
          icon: icons.config,
          tone: 'warn',
          title: a.space ? t('alerts.spaceGuideMissingTitle', { name: a.space.name }) : t('alerts.guideMissingTitle'),
          body: rich(t(a.space ? 'alerts.spaceGuideMissingBody' : 'alerts.guideMissingBody'), { note: mono(a.note) }),
          actions: null,
        })
      case 'config_template_missing':
        return frame({
          icon: icons.config,
          title: t('alerts.templateTitle', { series: a.series }),
          body: rich(t('alerts.templateBody'), { template: mono(a.template) }),
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
              {a.paths.slice(0, 10).map((p) => <li key={p}>{mono(p)}</li>)}
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
      case 'history_purged':
        return frame({
          icon: icons.config,
          title: t(a.version ? 'alerts.purgedVersionTitle' : 'alerts.purgedTitle', { by: a.by }),
          // The path only where the admin can read it (or purged it themselves): otherwise that it happened, and when.
          body: rich(t(a.path === null ? (a.version ? 'alerts.purgedVersionBodyHidden' : 'alerts.purgedBodyHidden') : a.version ? 'alerts.purgedVersionBody' : 'alerts.purgedBody'), {
            path: a.path === null ? null : mono(a.path),
            version: <span className="mono">{a.version?.slice(0, 7) ?? ''}</span>,
            when: dates.dateTime(a.at),
          }),
          actions: a.actions.includes('dismiss') && <Button className="btn" isDisabled={busy} onPress={() => act(() => historyApi.dismissPurge(a.id))}>{t('alerts.dismiss')}</Button>,
        })
      case 'account_changed':
      case 'user_account_changed':
      case 'history_purged_authored':
      case 'links_not_updated':
      case 'space_changed':
      case 'shared_with_you':
      case 'retention_ran':
      case 'moved_out':
      case 'removed_from':
      case 'space_deleted':
      case 'space_restored':
      case 'space_renamed':
      case 'account_key_added': {
        const when = dates.dateTime(a.at)
        const n = noticeTitle(a)
        const restorable = a.code === 'space_deleted' && a.deleted !== null && a.actions.includes('restore_space')
        const body = a.code === 'moved_out' ? t('alerts.movedOutBody', { when })
          : a.code === 'removed_from' ? t('alerts.removedFromBody', { when })
          : a.code === 'space_deleted' ? t(restorable ? 'alerts.spaceWasDeletedRestorable' : 'alerts.spaceWasDeletedBody', { when })
          : a.code === 'space_restored' ? t('alerts.spaceRestoredBody', { when })
          : a.code === 'space_renamed' ? t('alerts.spaceRenamedBody', { when, by: a.by })
          : a.code === 'account_key_added' ? t('alerts.keyAddedBody', { when })
          : a.code === 'account_changed'
          ? t(a.change === 'reset_link' ? 'alerts.accountResetLinkBody' : a.change === 'two_factor_reset' ? 'alerts.accountTwoFactorBody' : 'alerts.accountRoleBody', { when })
          : a.code === 'user_account_changed'
            // The person isn't told of an invitation, nor of being disabled or deleted.
            ? t(a.user === a.by || a.change === 'invite_link' || a.change === 'disabled' || a.change === 'deleted' ? 'alerts.userChangedSelfBody' : 'alerts.userChangedBody', { when, user: a.user })
            : a.code === 'links_not_updated' ? t('alerts.linksNotUpdatedBody', { when })
            : a.code === 'retention_ran' ? t(a.failed ? 'alerts.retentionFailedBody' : 'alerts.retentionBody', { when, entries: a.trashEntries, versions: a.versions })
            : a.code === 'space_changed' ? t('alerts.spaceChangedBody', { when })
            : a.code === 'shared_with_you' ? t(a.path === null ? 'alerts.sharedWithYouGoneBody' : a.kind === 'space' ? 'alerts.sharedWithYouBody' : 'alerts.sharedFolderBody', { when })
            : t('alerts.purgedAuthoredBody', { when })
        const spaced = a.code === 'shared_with_you' || a.code === 'space_changed' || a.code === 'removed_from' || a.code === 'space_deleted' || a.code === 'space_restored' || a.code === 'space_renamed' || a.code === 'moved_out'
        return frame({
          icon: a.code === 'history_purged_authored' || a.code === 'links_not_updated' || a.code === 'retention_ran' ? icons.config : spaced ? icons.people : icons.person,
          tone: a.code === 'account_changed' || a.code === 'shared_with_you' || a.code === 'account_key_added' || restorable ? 'accent' : undefined,
          title: rich(t(n.key), { by: <b>{n.parts.by}</b>, user: <b>{n.parts.user}</b>, path: n.parts.path ? mono(n.parts.path) : null, to: <b>{n.parts.to}</b>, space: <b>{n.parts.space}</b>, name: <b>{n.parts.name}</b>, owner: <b>{n.parts.owner}</b>, from: <b>{n.parts.from}</b> }),
          body,
          actions: (
            <>
              {/* A deleted space back whole, for who managed it: the notice goes when it's back. */}
              {restorable && <Button className="btn btn-primary" isDisabled={busy} onPress={() => act(async () => { await api.restoreSpace(a.deleted!); await api.dismissNotice(a.id) })}>{t('alerts.restoreSpace')}</Button>}
              <Button className="btn" isDisabled={busy} onPress={() => act(() => api.dismissNotice(a.id))}>{t('alerts.dismiss')}</Button>
            </>
          ),
        })
      }
      case 'two_factor_unreadable':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: a.users.length === 1 ? t('alerts.unreadableTitleOne', { user: a.users[0]! }) : t('alerts.unreadableTitle', { n: a.users.length }),
          body: t('alerts.unreadableBody'),
          extra: a.users.length > 1 && <ul className="alert-paths">{a.users.map((u) => <li key={u}>{u}</li>)}</ul>,
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
      case 'permissions_rejected':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.permissionsRejectedTitle'),
          body: t(a.fallback === 'closed' ? 'alerts.permissionsRejectedClosed' : 'alerts.permissionsRejectedLastGood'),
          actions: null,
        })
      case 'permissions_missing':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.permissionsMissingTitle'),
          body: rich(t('alerts.permissionsMissingBody'), { file: <span className="mono">{a.file}</span> }),
          actions: (
            <>
              {a.actions.includes('restore_permissions') && <Button className="btn btn-primary" isDisabled={busy} onPress={() => setRestoringPermissions(true)}>{t('alerts.restorePermissions')}</Button>}
              {a.actions.includes('dismiss') && <Button className="btn" isDisabled={busy} onPress={() => act(() => api.dismissMissingPermissions())}>{t('alerts.dismiss')}</Button>}
            </>
          ),
        })
      case 'notes_too_large':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.notesTooLargeTitle'),
          body: t('alerts.notesTooLargeBody', { limit: a.limitMb }),
          extra: (
            <ul className="alert-paths">
              {a.paths.slice(0, 10).map((p) => <li key={p}>{noteLink(p)}</li>)}
              {a.paths.length > 10 && <li>{t('alerts.movedMore', { n: a.paths.length - 10 })}</li>}
              {a.elsewhere.map((p) => <li key={`in:${p}`}>{rich(t('alerts.notesTooLargeIn'), { path: <span className="mono">{p}</span> })}</li>)}
            </ul>
          ),
          actions: null,
        })
      case 'permissions_held':
        return frame({
          icon: icons.moved,
          tone: 'warn',
          title: a.notes === 1 ? t('alerts.heldTitleOne') : t('alerts.heldTitle', { n: a.notes }),
          body: rich(t('alerts.heldBody'), { folder: mono(a.folder) }),
          actions: a.actions.includes('release') && <Button className="btn" isDisabled={busy} onPress={() => act(() => api.held(a.id, 'release'))}>{t('alerts.heldRelease')}</Button>,
        })
      case 'missing_folder':
        return frame({
          icon: icons.config,
          title: t('alerts.missingFolderTitle'),
          body: t('alerts.missingFolderBody'),
          extra: <ul className="alert-paths">{a.folders.map((f) => <li key={f}>{mono(f)}</li>)}</ul>,
          actions: null,
        })
      case 'outside_spaces':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.outsideSpacesTitle'),
          // Where it can go: the admin's own space, by its exact path.
          body: t('alerts.outsideSpacesBody'),
          // Where each one is on the server's disk (the only place it is): labelled as such.
          extra: <ul className="alert-paths">{a.paths.map((p) => <li key={p}><span className="mono">{t('alerts.onDisk', { path: p })}</span></li>)}</ul>,
          actions: null,
        })
      case 'unreadable_notes':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.unreadableNotesTitle'),
          body: t('alerts.unreadableNotesBody'),
          // Where each one is on the server's disk; a note the admin doesn't read, only by the space that holds it.
          extra: (
            <ul className="alert-paths">
              {a.paths.slice(0, 10).map((p) => <li key={p}><span className="mono">{t('alerts.onDisk', { path: p })}</span></li>)}
              {a.paths.length > 10 && <li>{t('alerts.movedMore', { n: a.paths.length - 10 })}</li>}
              {a.elsewhere.map((p) => <li key={`in:${p}`}>{rich(t('alerts.unreadableNotesIn'), { path: <span className="mono">{p}</span> })}</li>)}
            </ul>
          ),
          actions: null,
        })
      case 'closed_spaces':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: a.people.length === 1 ? t('alerts.closedSpacesTitleOne', { user: a.people[0]! }) : t('alerts.closedSpacesTitle', { n: a.people.length }),
          body: t('alerts.closedSpacesBody'),
          extra: a.people.length > 1 ? <ul className="alert-paths">{a.people.map((n) => <li key={n}>{n}</li>)}</ul> : undefined,
          actions: <Button className="btn" onPress={onSpaces}>{t('alerts.closedSpacesGo')}</Button>,
        })
      case 'person_folder_without_user':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.personFolderTitle'),
          body: t('alerts.personFolderBody'),
          extra: <ul className="alert-paths">{a.names.map((n) => <li key={n}><span className="mono">{t('alerts.onDisk', { path: `people/${n}` })}</span></li>)}</ul>,
          actions: null,
        })
      case 'space_without_members':
      case 'space_without_managers':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t(a.code === 'space_without_members' ? 'alerts.spaceNoMembersTitle' : 'alerts.spaceNoManagersTitle', { name: a.name }),
          body: rich(t(a.code === 'space_without_members' ? 'alerts.spaceNoMembersBody' : 'alerts.spaceNoManagersBody'), { path: <b>{a.name}</b> }),
          actions: null,
        })
      case 'space_not_renamed':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.spaceNotRenamedTitle', { name: a.name }),
          body: rich(t('alerts.spaceNotRenamedBody'), { name: <b>{a.name}</b>, wanted: <b>{a.wanted}</b> }),
          actions: null,
        })
      case 'login_attempts_blocked':
        return frame({
          icon: icons.warn,
          tone: 'warn',
          title: t('alerts.loginBlockedTitle', { n: a.attempts, since: dates.dateTime(a.since) }),
          body: t('alerts.loginBlockedBody'),
          actions: null,
        })
      case 'sync_conflict': {
        const shown = a.path in copies
        return frame({
          icon: icons.sync,
          title: t('alerts.syncTitle'),
          body: a.note
            ? rich(t('alerts.syncBody'), { file: <span className="mono">{baseName(a.path)}</span>, note: <b>{noteName(a.note)}</b> })
            : rich(t('alerts.syncBodyAlone'), { file: mono(a.path) }),
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
        <BackButton />
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
      <ModalOverlay className="modal-overlay" isOpen={restoringPermissions} onOpenChange={(o) => { if (!o) setRestoringPermissions(false) }} isDismissable>
        <Modal className="modal">
          {restoringPermissions && <RestorePermissionsDialog onClose={() => setRestoringPermissions(false)} onDone={() => { setRestoringPermissions(false); void load() }} />}
        </Modal>
      </ModalOverlay>
      {relinkJob && <MoveProgress key={relinkJob.id} job={relinkJob} onFinished={relinkEnded} />}
    </>
  )
}
