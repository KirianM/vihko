// The permissions UI (D-038, m4 §4): a folder's permissions dialog (who has
// which level, inherited rows with where they come from, «own permissions ·
// restore inheritance», the cascade said plainly, closed to agents), the
// effective access of a folder (who and why), of a person or of a key (which
// folders, as a tree), and the admin's list of every folder's name to open
// its permissions (D-038.1: names, never contents).
//
// Changes are a draft saved at once with thoth.yaml's ETag: if the file
// changed meanwhile (412), the dialog loads it again and says so; if thoth
// can't write it as it is (409 `config_invalid`), it's fixed by hand.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Dialog, Heading, Input, Tab, TabList, TabPanel, Tabs, TextField } from 'react-aria-components'
import { ApiError, LEVELS, api, atLeast, type EffectiveAccess, type FolderLock, type FolderPermissions, type Grants, type Level, type User } from './api.ts'
import { Toggle } from './Agents.tsx'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { Icon } from './ui.tsx'
import './actions.css'
import './agents.css'
import './permissions.css'

type Translate = ReturnType<typeof useT>

export const LEVEL_LABEL: Record<Level, MessageKey> = { read: 'level.read', comment: 'level.comment', edit: 'level.edit', manage: 'level.manage' }
/** A folder as the dialogs name it: `/familia/recetas`, `/` for the root. */
export const folderLabel = (folder: string) => `/${folder}`
const baseName = (folder: string) => (folder === '' ? '/' : folder.slice(folder.lastIndexOf('/') + 1))
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const isGroup = (s: string) => s.startsWith('@')
/** Users first, then groups, alphabetically. */
const sortSubjects = (a: string, b: string) => (isGroup(a) === isGroup(b) ? collator.compare(a, b) : isGroup(a) ? 1 : -1)
const same = (a: Grants | null, b: Grants | null) => {
  if (a === null || b === null) return a === b
  const ka = Object.keys(a).sort()
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

/** The level picker of a row: a native select, as in the rest of the settings. */
function LevelSelect({ value, label, disabled, onChange }: { value: Level; label: string; disabled?: boolean; onChange: (l: Level) => void }) {
  const t = useT()
  return (
    <select className="select perm-level" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Level)}>
      {LEVELS.map((l) => <option key={l} value={l}>{t(LEVEL_LABEL[l])}</option>)}
    </select>
  )
}

function Subject({ subject, me }: { subject: string; me: string }) {
  const t = useT()
  return (
    <span className="perm-subject">
      <span className={`perm-avatar${isGroup(subject) ? ' perm-avatar-group' : ''}`} aria-hidden="true">{isGroup(subject) ? Icon.people : subject.slice(0, 1).toUpperCase()}</span>
      <span className="perm-name">{subject}</span>
      {subject.toLowerCase() === me.toLowerCase() && <span className="perm-you">{t('perm.you')}</span>}
    </span>
  )
}

/** A folder link inside the dialog: opens that folder's permissions, if whoever looks may. */
function FolderLink({ folder, canOpen, onOpen }: { folder: string; canOpen: (f: string) => boolean; onOpen: (f: string) => void }) {
  if (!canOpen(folder)) return <span className="mono">{folderLabel(folder)}</span>
  return <Button className="perm-folder-link mono" onPress={() => onOpen(folder)}>{folderLabel(folder)}</Button>
}

/** Why someone has access, in words: through whom and where it's written (or which folder above they manage). */
function viaText(t: Translate, via: FolderPermissions['access'][number]['via'][number], username: string): string {
  const through = via.subject.toLowerCase() === username.toLowerCase() || via.subject === '{user}' ? t('perm.viaDirect') : t('perm.viaGroup', { group: via.subject })
  const where = via.above ? t('perm.viaAbove', { folder: folderLabel(via.from) })
    : via.rule ? t('perm.viaRule', { rule: via.rule }) : t('perm.viaFolder', { folder: folderLabel(via.from) })
  return `${through} · ${where}`
}

/**
 * Who sees a folder with no grants (D-040 3.5): nobody at all, and in a
 * personal folder not the admin either; elsewhere, only whoever manages it
 * from above.
 */
function nobodyText(view: FolderPermissions): MessageKey {
  if (view.managedAbove.length > 0) return 'perm.onlyAbove'
  return view.personal !== null ? 'perm.nobody' : 'perm.nobodyAtAll'
}

/** Whoever manages it from above, with where: «noa (in /), @family (in /family)». */
function managersText(t: Translate, managers: FolderPermissions['managedAbove']): string {
  return managers.map((m) => t('perm.managerAt', { who: m.subject, folder: folderLabel(m.from) })).join(', ')
}

type Draft = { grants: Grants | null; ai: boolean }

/**
 * A folder's permissions. `canOpen`: whether a folder named inside (where
 * something is inherited from) opens its own permissions here. `onAccessLost`:
 * the person gave away their own `manage` and can't see them any more.
 */
export function PermissionsDialog({ folder: start, me, canOpen, onClose, onChanged, onAccessLost, onUnauthorized }: {
  folder: string
  me: User
  canOpen: (folder: string) => boolean
  onClose: () => void
  /** Saved: the tree's locks and levels may have changed. */
  onChanged: () => void
  onAccessLost: () => void
  onUnauthorized: () => void
}) {
  const t = useT()
  const [folder, setFolder] = useState(start)
  const [view, setView] = useState<FolderPermissions | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [directory, setDirectory] = useState<{ users: string[]; groups: string[] } | null>(null)
  const [adding, setAdding] = useState<{ subject: string; level: Level }>({ subject: '', level: 'read' })
  const [tab, setTab] = useState<'grants' | 'access'>('grants')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(err instanceof ApiError && err.code === 'config_invalid' ? t('perm.configInvalid') : errorText(t, err))
  }
  const literal = (v: FolderPermissions) => (v.own && v.own.user === null ? v.own : null)
  const show = (v: FolderPermissions) => {
    setView(v)
    const own = literal(v)
    setDraft({ grants: own?.grants ? { ...own.grants } : null, ai: own?.ai === true })
  }
  const load = (f: string) => api.permissions(f).then(show).catch((err) => { setView(null); fail(err) })
  useEffect(() => { setError(null); setNotice(null); setView(null); void load(folder) }, [folder]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.directory().then(setDirectory).catch(() => setDirectory({ users: [], groups: [] })) }, [])

  const own = view ? literal(view) : null
  const savedGrants = own?.grants ?? null
  // Without grants of its own, what governs it: a `{user}` rule matching it, or what its parent gives.
  const fallback = view?.userRule
    ? { kind: 'user' as const, grants: view.userRule.grants, rule: view.userRule.rule, from: folder }
    : view?.inherited ? { kind: 'inherited' as const, grants: view.inherited.grants, rule: view.inherited.rule, from: view.inherited.from } : null
  const readOnly = !view || !view.canEdit || view.section === 'closed'
  const custom = draft?.grants ?? null
  const aiFromAbove = !!view && view.ai.closed && own?.ai !== true
  const dirty = !!view && !!draft && (!same(draft.grants, savedGrants) || draft.ai !== (own?.ai === true))
  // Without own grants nor anything above (the root, or the implicit section): what applies now.
  const shown: Grants = custom ?? fallback?.grants ?? view?.effective.grants ?? {}
  const subjects = Object.keys(shown).sort(sortSubjects)
  const meKey = me.username.toLowerCase()
  // Whoever manages it from above keeps `manage` here whatever it says (D-040 3.5): the others among them.
  const managers = view?.managedAbove ?? []
  const othersAbove = managers.filter((m) => m.subject.toLowerCase() !== meKey)
  const onlyMe = subjects.length > 0 && subjects.every((s) => s.toLowerCase() === meKey) && othersAbove.length === 0
  // Giving away one's own `manage` (not the admin, nor whoever manages it from above): they won't see these permissions again.
  const losesManage = me.role !== 'admin' && custom !== null && !atLeast(custom[Object.keys(custom).find((s) => s.toLowerCase() === meKey) ?? ''] ?? null, 'manage')
    && !!view?.access.some((a) => a.id === me.id && a.level === 'manage' && a.via.every((v) => !isGroup(v.subject) && !v.above))
  const candidates = useMemo(() => {
    if (!directory || custom === null) return { users: [], groups: [] }
    const taken = new Set(Object.keys(custom).map((s) => s.toLowerCase()))
    return {
      users: directory.users.filter((u) => !taken.has(u.toLowerCase())).sort(collator.compare),
      groups: directory.groups.filter((g) => !taken.has(`@${g}`.toLowerCase())).sort(collator.compare),
    }
  }, [directory, custom])

  const setGrants = (grants: Grants | null) => setDraft((d) => (d ? { ...d, grants } : d))
  const save = async () => {
    if (!view || !draft || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const change: { grants?: Grants | null; ai?: false | null } = {}
    if (!same(draft.grants, savedGrants)) change.grants = draft.grants
    if (draft.ai !== (own?.ai === true)) change.ai = draft.ai ? false : null
    try {
      const r = await api.setPermissions(folder, change, view.etag)
      onChanged()
      if (!('access' in r)) return onAccessLost()
      show(r)
      setNotice(t('perm.saved'))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'precondition_failed') {
        // thoth.yaml changed meanwhile (another person, an editor): what it says now, and nothing was saved.
        await load(folder)
        setNotice(null)
        setError(t('perm.stale'))
      } else fail(err)
    }
    setBusy(false)
  }

  const add = () => {
    if (!adding.subject || custom === null) return
    setGrants({ ...custom, [adding.subject]: adding.level })
    setAdding({ subject: '', level: 'read' })
  }

  let origin: ReactNode = null
  if (view && custom !== null) {
    origin = (
      <p className="perm-origin">
        <span className="perm-origin-text">{Icon.lock}<strong>{t('perm.own')}</strong></span>
        {fallback && !readOnly && <Button className="perm-inline-btn" onPress={() => setGrants(null)}>{t(fallback.kind === 'user' ? 'perm.restoreUser' : 'perm.restore')}</Button>}
      </p>
    )
  } else if (view && fallback) {
    origin = (
      <p className="perm-origin">
        <span className="perm-origin-text">
          {fallback.kind === 'user'
            ? <span>{t('perm.byUserRule', { rule: fallback.rule })}</span>
            : <span>{t('perm.inheritsFrom')} <FolderLink folder={fallback.from} canOpen={canOpen} onOpen={setFolder} />{fallback.rule !== fallback.from && <> {t('perm.ruleParen', { rule: fallback.rule })}</>}</span>}
        </span>
        {!readOnly && <Button className="perm-inline-btn" onPress={() => setGrants({ ...fallback.grants })}>{t('perm.customize')}</Button>}
      </p>
    )
  } else if (view) {
    origin = (
      <p className="perm-origin">
        <span className="perm-origin-text">{t('perm.noneWritten')}</span>
        {!readOnly && <Button className="perm-inline-btn" onPress={() => setGrants({ ...view.effective.grants })}>{t('perm.customize')}</Button>}
      </p>
    )
  }

  const rowLabel = (s: string) => t('perm.levelOf', { who: s })
  return (
    <Dialog className="dialog perm-dialog" aria-label={t('perm.title', { name: baseName(folder) })}>
      <div className="dialog-fields">
        <div>
          <Heading slot="title" className="dialog-title">{t('perm.title', { name: baseName(folder) })}</Heading>
          <p className="perm-path mono">{folderLabel(folder)}</p>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        {!view ? (!error && <p className="hint">{t('common.loading')}</p>) : (
          <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k === 'access' ? 'access' : 'grants')}>
            <TabList className="cfg-tabs" aria-label={t('perm.tabs')}>
              <Tab id="grants" className="cfg-tab">{t('perm.tabGrants')}</Tab>
              <Tab id="access" className="cfg-tab">{t('perm.tabAccess')}</Tab>
            </TabList>
            <TabPanel id="grants" className="cfg-panel perm-panel">
              {view.section === 'closed' && <p className="key-locked" role="note">{Icon.alert}<span>{t('perm.sectionClosed')}</span></p>}
              {view.section === 'implicit' && <p className="hint">{t('perm.implicit')}</p>}
              {readOnly && view.section !== 'closed' && <p className="hint">{t('perm.readOnly')}</p>}
              {origin}
              {view.userRule && custom !== null && <p className="hint">{t('perm.overridesUserRule', { rule: view.userRule.rule })}</p>}
              {subjects.length === 0 ? (
                <p className="perm-nobody">{Icon.lock}<span>{t(nobodyText(view))}</span></p>
              ) : (
                <ul className="perm-rows" aria-label={t('perm.rows')}>
                  {subjects.map((s) => (
                    <li key={s} className="perm-row">
                      <Subject subject={s} me={me.username} />
                      {custom !== null && !readOnly ? (<>
                        <LevelSelect value={custom[s]!} label={rowLabel(s)} onChange={(l) => setGrants({ ...custom, [s]: l })} />
                        <Button className="btn btn-icon btn-quiet perm-remove" aria-label={t('perm.remove', { who: s })} onPress={() => { const next = { ...custom }; delete next[s]; setGrants(next) }}>{Icon.close}</Button>
                      </>) : (
                        <span className="perm-row-level">
                          <span className="perm-level-text">{t(LEVEL_LABEL[shown[s]!])}</span>
                          {custom === null && fallback && (
                            <span className="perm-row-from">
                              {fallback.kind === 'user' ? t('perm.fromUserRule', { rule: fallback.rule }) : <>{t('perm.inheritedFrom')} <FolderLink folder={fallback.from} canOpen={canOpen} onOpen={setFolder} /></>}
                            </span>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {onlyMe && <p className="hint">{t('perm.onlyYou')}</p>}
              {managers.length > 0 && <p className="hint perm-managers">{t('perm.managedAbove', { who: managersText(t, managers) })}</p>}
              {custom !== null && !readOnly && (
                <div className="perm-add">
                  <select className="select perm-add-who" aria-label={t('perm.addWho')} value={adding.subject} onChange={(e) => setAdding({ ...adding, subject: e.target.value })}>
                    <option value="">{t('perm.addPick')}</option>
                    {candidates.users.length > 0 && <optgroup label={t('perm.people')}>{candidates.users.map((u) => <option key={u} value={u}>{u}</option>)}</optgroup>}
                    {candidates.groups.length > 0 && <optgroup label={t('perm.groups')}>{candidates.groups.map((g) => <option key={g} value={`@${g}`}>@{g}</option>)}</optgroup>}
                  </select>
                  <LevelSelect value={adding.level} label={t('perm.addLevel')} onChange={(level) => setAdding({ ...adding, level })} />
                  <Button className="btn" isDisabled={!adding.subject} onPress={add}>{Icon.plus}{t('perm.add')}</Button>
                </div>
              )}
              {losesManage && <p className="key-once" role="note">{Icon.alert}<span>{t('perm.losesManage')}</span></p>}
              <p className="perm-cascade">{t('perm.cascade')}</p>
              <p className="hint">{t('perm.levels')}</p>
              <div className="switches perm-agents">
                <Toggle label={t('perm.aiTitle')}
                  hint={aiFromAbove ? (view.ai.from === folder ? t('perm.aiByRule') : t('perm.aiFrom', { folder: folderLabel(view.ai.from ?? '') })) : t('perm.aiHint')}
                  value={aiFromAbove || !!draft?.ai} disabled={readOnly || aiFromAbove}
                  onChange={(v) => setDraft((d) => (d ? { ...d, ai: v } : d))} />
              </div>
            </TabPanel>
            <TabPanel id="access" className="cfg-panel perm-panel">
              <FolderAccess view={view} />
              {dirty && <p className="hint">{t('perm.accessSaved')}</p>}
            </TabPanel>
          </Tabs>
        )}
      </div>
      {notice && <p className="perm-notice dialog-error" role="status">{notice}</p>}
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose}>{t(dirty ? 'common.cancel' : 'perm.close')}</Button>
        {view && !readOnly && <Button className="btn btn-primary" isDisabled={!dirty || busy} onPress={() => void save()}>{t('perm.save')}</Button>}
      </div>
    </Dialog>
  )
}

/** Who can read, comment, edit or manage a folder, and why (saved permissions). */
export function FolderAccess({ view }: { view: FolderPermissions }) {
  const t = useT()
  const rows = [...view.access].sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || collator.compare(a.username, b.username))
  return (
    <>
      <p className="hint">{t('perm.accessIntro')}</p>
      {rows.length === 0 ? <p className="perm-nobody">{Icon.lock}<span>{t(nobodyText(view))}</span></p> : (
        <ul className="perm-rows" aria-label={t('perm.tabAccess')}>
          {rows.map((a) => (
            <li key={a.id} className="perm-row perm-row-access">
              <span className="perm-subject">
                <span className="perm-avatar" aria-hidden="true">{a.username.slice(0, 1).toUpperCase()}</span>
                <span className="perm-name">{a.username}</span>
              </span>
              <span className="perm-row-level">
                <span className="perm-level-text">{t(LEVEL_LABEL[a.level])}</span>
                {a.via.map((v, i) => <span key={i} className="perm-row-from">{viaText(t, v, a.username)}</span>)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">{t('perm.accessAdmin')}</p>
    </>
  )
}

/** Folders as a tree of names: each with the folders above it (those not in the list shown only as the way). */
function treeRows<T extends { folder: string }>(items: T[]): { folder: string; depth: number; item: T | null }[] {
  const byPath = new Map(items.map((i) => [i.folder, i]))
  const all = new Set<string>()
  for (const i of items) {
    all.add(i.folder)
    if (i.folder !== '') {
      const parts = i.folder.split('/')
      for (let n = 1; n < parts.length; n++) all.add(parts.slice(0, n).join('/'))
    }
  }
  const sorted = [...all].sort((a, b) => {
    if (a === '') return -1
    if (b === '') return 1
    const pa = a.split('/'), pb = b.split('/')
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const c = collator.compare(pa[i]!, pb[i]!)
      if (c) return c
    }
    return pa.length - pb.length
  })
  return sorted.map((f) => ({ folder: f, depth: f === '' ? 0 : f.split('/').length - (all.has('') ? 0 : 1), item: byPath.get(f) ?? null }))
}

/** Which folders a person or a key reaches, as a tree, with the level in each. */
export function AccessTree({ access }: { access: EffectiveAccess }) {
  const t = useT()
  const rows = treeRows(access.folders)
  if (rows.length === 0) return <p className="perm-nobody">{Icon.lock}<span>{t('perm.seesNothing')}</span></p>
  return (
    <ul className="access-tree" aria-label={t('perm.accessTree')}>
      {rows.map((r) => (
        <li key={r.folder} className={`access-row${r.item ? '' : ' access-row-path'}`} style={{ paddingLeft: `calc(${r.depth} * var(--space-4) + var(--space-3))` }}>
          <span className="access-icon" aria-hidden="true">{Icon.folder}</span>
          <span className="access-name">{r.folder === '' ? t('perm.root') : baseName(r.folder)}</span>
          {r.item
            ? <span className={`access-level access-level-${r.item.level}`}>{t(LEVEL_LABEL[r.item.level])}</span>
            : <span className="access-way">{t('perm.onlyWay')}</span>}
        </li>
      ))}
    </ul>
  )
}

/** The effective access of a person or a key, in a dialog. */
export function AccessDialog({ who, title, onClose, onUnauthorized }: { who: { user: string } | { key: string }; title: string; onClose: () => void; onUnauthorized: () => void }) {
  const t = useT()
  const [access, setAccess] = useState<EffectiveAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = 'user' in who ? who.user : who.key
  useEffect(() => {
    api.access(who).then(setAccess).catch((err) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setError(errorText(t, err))
    })
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog className="dialog perm-dialog" aria-label={title}>
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{title}</Heading>
        <p className="dialog-text">{t('key' in who ? 'perm.keyAccessIntro' : 'perm.userAccessIntro')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        {!access ? (!error && <p className="hint">{t('common.loading')}</p>) : <AccessTree access={access} />}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('perm.close')}</Button>
      </div>
    </Dialog>
  )
}

/**
 * Every folder's name with its locks, to open its permissions: the admin's
 * view in «Users and groups» (D-038.1: the names, never what's inside).
 */
export function FolderPermissionsList({ refresh, onOpen, onUnauthorized }: { refresh: number; onOpen: (folder: string) => void; onUnauthorized: () => void }) {
  const t = useT()
  const [folders, setFolders] = useState<FolderLock[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    api.permissionFolders().then((r) => setFolders(r.folders)).catch((err) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setError(errorText(t, err))
    })
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="error-text" role="alert">{error}</p>
  if (!folders) return <p className="hint">{t('common.loading')}</p>
  const q = filter.trim().toLowerCase()
  const rows = treeRows(folders.map((f) => ({ ...f, folder: f.path }))).filter((r) => !q || r.folder.toLowerCase().includes(q))
  return (
    <div className="perm-folders">
      {folders.length > 8 && (
        <TextField className="field folder-filter" value={filter} onChange={setFilter} aria-label={t('keys.folderFilter')}>
          <Input placeholder={t('keys.folderFilter')} />
        </TextField>
      )}
      <ul className="access-tree" aria-label={t('perm.foldersList')}>
        {rows.map((r) => (
          <li key={r.folder} className="access-row" style={{ paddingLeft: `calc(${q ? 0 : r.depth} * var(--space-4) + var(--space-3))` }}>
            <span className="access-icon" aria-hidden="true">{Icon.folder}</span>
            <span className="access-name">{r.folder === '' ? t('perm.root') : q ? r.folder : baseName(r.folder)}</span>
            <LockBadges own={!!r.item?.ownGrants} ai={!!r.item?.aiClosed} />
            <span className="spacer" />
            {r.item?.canEdit && <Button className="btn perm-open" aria-label={t('perm.openFor', { folder: folderLabel(r.folder) })} onPress={() => onOpen(r.folder)}>{t('perm.open')}</Button>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The marks of a folder with permissions of its own, or closed to agents (tree and lists). */
export function LockBadges({ own, ai }: { own: boolean; ai: boolean }) {
  const t = useT()
  if (!own && !ai) return null
  return (
    <span className="lock-badges">
      {own && <span className="lock-badge" role="img" aria-label={t('perm.lockOwn')} title={t('perm.lockOwn')}>{Icon.lock}</span>}
      {ai && <span className="lock-badge lock-badge-ai" role="img" aria-label={t('perm.lockAi')} title={t('perm.lockAi')}>{Icon.eyeOff}</span>}
    </span>
  )
}
