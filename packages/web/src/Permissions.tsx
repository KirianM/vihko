// Sharing: who a folder is shared with. The members of a
// shared space are its root's grants («Members of Home»); a folder of one's
// own space is shared with people or groups at a level. Sharing only adds
// (so nothing hidden takes up names where notes are created): what the
// folders above give is shown, where it comes from, and can't be taken
// away here; a level below it isn't offered. The effective access of a folder (who and why), of a person or of a key (which folders,
// as a tree), and the locks of the tree are here too.
//
// Changes are a draft saved at once with vihko.yaml's ETag: if the file
// changed meanwhile (412), the dialog loads it again and says so; if vihko
// can't write it as it is (409 `config_invalid`), it's fixed by hand. A
// draft is never lost unawares: closing the dialog with changes not saved
// (its button, Escape, a press outside) asks first. Whoever manages it can't
// take themselves out with the × of their own row, which would lock them
// out: their row offers «Leave» instead, as the space's menu does.
import { useEffect, useMemo, useState } from 'react'
import { Button, Dialog, Heading, Tab, TabList, TabPanel, Tabs } from 'react-aria-components'
import { ApiError, LEVELS, api, atLeast, type EffectiveAccess, type FolderPermissions, type GrantSource, type Grants, type Level, type MembersView, type User } from './api.ts'
import { Toggle } from './Agents.tsx'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { usePathLabels, useSpaces, useSpacesValue } from './spaces.tsx'
import { Icon, useDismissGuard } from './ui.tsx'
import './actions.css'
import './agents.css'
import './permissions.css'

type Translate = ReturnType<typeof useT>

export const LEVEL_LABEL: Record<Level, MessageKey> = { read: 'level.read', comment: 'level.comment', edit: 'level.edit', manage: 'level.manage' }
const baseName = (folder: string) => folder.slice(folder.lastIndexOf('/') + 1)
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const isGroup = (s: string) => s.startsWith('@')
const key = (s: string) => s.normalize('NFC').toLowerCase()
/** Users first, then groups, alphabetically. */
const sortSubjects = (a: string, b: string) => (isGroup(a) === isGroup(b) ? collator.compare(a, b) : isGroup(a) ? 1 : -1)
const same = (a: Grants | null, b: Grants | null) => {
  const x = a && Object.keys(a).length ? a : null
  const y = b && Object.keys(b).length ? b : null
  if (x === null || y === null) return x === y
  const kx = Object.keys(x).sort()
  return kx.length === Object.keys(y).length && kx.every((k) => x[k] === y[k])
}
const higher = (a: Level | null, b: Level) => (a === null || LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a)

/** The level picker of a row: a native select, as in the rest of the settings; only `from` and above. */
function LevelSelect({ value, label, from, onChange }: { value: Level; label: string; from?: Level | null; onChange: (l: Level) => void }) {
  const t = useT()
  const options = LEVELS.filter((l) => l === value || !from || LEVELS.indexOf(l) > LEVELS.indexOf(from))
  return (
    <select className="select perm-level" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Level)}>
      {options.map((l) => <option key={l} value={l}>{t(LEVEL_LABEL[l])}</option>)}
    </select>
  )
}

function Subject({ subject, me }: { subject: string; me: string }) {
  const t = useT()
  return (
    <span className="perm-subject">
      <span className={`perm-avatar${isGroup(subject) ? ' perm-avatar-group' : ''}`} aria-hidden="true">{isGroup(subject) ? Icon.people : subject.slice(0, 1).toUpperCase()}</span>
      <span className="perm-name">{subject}</span>
      {key(subject) === key(me) && <span className="perm-you">{t('perm.you')}</span>}
    </span>
  )
}

/** Why someone has access, in words: their own space, or through whom and where it's shared. */
function viaText(t: Translate, via: GrantSource, username: string, where: (folder: string) => string): string {
  if (via.owner) return t('perm.viaOwner')
  const through = key(via.subject) === key(username) ? t('perm.viaDirect') : t('perm.viaGroup', { group: via.subject })
  return `${through} · ${t('perm.viaFolder', { folder: where(via.from) })}`
}

type Draft = { grants: Grants; ai: boolean }

/**
 * Who a folder is shared with. `onAccessLost`: the person gave away their
 * own `manage` and can't see this any more.
 */
export function PermissionsDialog({ folder, me, onClose, onChanged, onAccessLost, onUnauthorized, onMoveTo, onLeave }: {
  folder: string
  me: User
  /** «Leave», on one's own row: the dialog that leaves the space (`shared`) or stops seeing the folder (`received`). */
  onLeave?: (kind: 'shared' | 'received', name: string) => void
  /**
   * «Move to a new space» or «to My notes», where this folder can't
   * be closed to those who see the one above it: the dialog that does it.
   */
  onMoveTo?: (target: 'newSpace' | 'mine') => void
  /** Whether a folder named inside opens its own dialog (unused: rows above are only named). */
  canOpen?: (folder: string) => boolean
  onClose: () => void
  /** Saved: the tree's marks and levels may have changed. */
  onChanged: () => void
  onAccessLost: () => void
  onUnauthorized: () => void
}) {
  const t = useT()
  const labels = usePathLabels()
  const spaces = useSpaces()
  const [view, setView] = useState<FolderPermissions | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [directory, setDirectory] = useState<{ users: string[]; groups: string[] } | null>(null)
  const [adding, setAdding] = useState<{ subject: string; level: Level }>({ subject: '', level: 'read' })
  const [tab, setTab] = useState<'grants' | 'access'>('grants')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Closing (or leaving) with changes not saved: asked first, and what to do once answered. */
  const [unsaved, setUnsaved] = useState<'close' | 'leave' | null>(null)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(err instanceof ApiError && err.code === 'config_invalid' ? t('perm.configInvalid') : errorText(t, err))
  }
  const ownAi = (v: FolderPermissions) => v.ai.closed && v.ai.from === v.folder
  const show = (v: FolderPermissions) => {
    setView(v)
    setDraft({ grants: { ...(v.own.grants ?? {}) }, ai: ownAi(v) })
  }
  const load = () => api.permissions(folder).then(show).catch((err) => { setView(null); fail(err) })
  useEffect(() => { setError(null); setNotice(null); setView(null); void load() }, [folder]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.directory().then(setDirectory).catch(() => setDirectory({ users: [], groups: [] })) }, [])

  /** Where each subject gets a level from above here: the highest, by subject. */
  const above = useMemo(() => {
    const m = new Map<string, Level>()
    for (const i of view?.inherited ?? []) for (const [s, l] of Object.entries(i.grants)) m.set(key(s), higher(m.get(key(s)) ?? null, l))
    // In someone's space, its owner manages all of it.
    if (view?.owner) m.set(key(view.owner), 'manage')
    return m
  }, [view])

  const isSpaceRoot = !!view && view.space !== null && view.space.path === view.folder
  const personalRoot = !!view && view.owner !== null && view.folder === `people/${view.owner}`
  const readOnly = !view || !view.canEdit || view.section === 'closed'
  const grants = draft?.grants ?? {}
  const subjects = Object.keys(grants).sort(sortSubjects)
  const aiFromAbove = !!view && view.ai.closed && view.ai.from !== view.folder
  const dirty = !!view && !!draft && (!same(draft.grants, view.own.grants) || draft.ai !== ownAi(view))
  // Giving away one's own `manage` written here, with nothing else that gives it (their space, a group, a folder above): they won't see this again.
  const meKey = key(me.username)
  const mine = (g: Grants | null) => Object.entries(g ?? {}).find(([s]) => key(s) === meKey)?.[1] ?? null
  const keepsManage = !!view?.access.find((a) => a.id === me.id)?.via.some((v) => v.level === 'manage' && !(v.from === view.folder && key(v.subject) === meKey))
  const losesManage = !!view && mine(view.own.grants) === 'manage' && !atLeast(mine(grants), 'manage') && !keepsManage
  const candidates = useMemo(() => {
    if (!directory || !view) return { users: [], groups: [] }
    const taken = new Set(Object.keys(grants).map(key))
    // Nobody who already manages it from above: nothing could be added for them.
    const open = (s: string) => !taken.has(key(s)) && above.get(key(s)) !== 'manage'
    return {
      users: directory.users.filter((u) => open(u) && key(u) !== key(view.owner ?? '')).sort(collator.compare),
      groups: directory.groups.filter((g) => open(`@${g}`)).sort(collator.compare),
    }
  }, [directory, grants, above, view])
  const addFrom = adding.subject ? above.get(key(adding.subject)) ?? null : null
  // A folder inside a space can't be closed to those who see the one above it (sharing only adds): it can move out instead.
  const inner = !!view && !isSpaceRoot && !personalRoot && view.space !== null
  const ownSpace = !!view && view.owner !== null && key(view.owner) === meKey
  const inShared = !!view && view.owner === null
  const toNewSpace = inner && !readOnly && (ownSpace || inShared) && !!spaces.info?.canCreate && !!onMoveTo
  const toMine = inner && !readOnly && inShared && !!onMoveTo
  // Edit in a folder of one's own space: whoever edits may work out the names of notes linked from it (a known limit).
  const probes = !!view && ownSpace && !personalRoot && Object.values(grants).some((l) => atLeast(l, 'edit'))
  // The level to add, never below what they already get from above.
  useEffect(() => {
    if (addFrom && !(LEVELS.indexOf(adding.level) > LEVELS.indexOf(addFrom))) setAdding((a) => ({ ...a, level: LEVELS[LEVELS.indexOf(addFrom) + 1] ?? 'manage' }))
  }, [addFrom]) // eslint-disable-line react-hooks/exhaustive-deps

  const setGrants = (g: Grants) => setDraft((d) => (d ? { ...d, grants: g } : d))
  // One's own row: the × would take away their own access (or their `manage`) with nothing else giving it.
  // They can leave instead, where leaving is theirs to do: their grant is written here, not reached from above.
  const ownRow = (s: string) => key(s) === meKey && !keepsManage
  const canLeave = !!view && !!onLeave && (isSpaceRoot || (view.owner !== null && key(view.owner) !== meKey)) && !above.has(meKey)
  const leaveKind: 'shared' | 'received' = isSpaceRoot ? 'shared' : 'received'
  const leaveName = () => (isSpaceRoot ? spaceName : baseName(folder))
  /** Closes, or asks first when there are changes not saved. */
  const requestClose = () => (dirty ? setUnsaved('close') : onClose())
  const requestLeave = () => (dirty ? setUnsaved('leave') : onLeave!(leaveKind, leaveName()))
  useDismissGuard(() => {
    if (!dirty) return false
    setUnsaved('close')
    return true
  })
  const save = async (then?: 'close') => {
    if (!view || !draft || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const change: { grants?: Grants | null; ai?: false | null } = {}
    if (!same(draft.grants, view.own.grants)) change.grants = Object.keys(draft.grants).length ? draft.grants : null
    if (draft.ai !== ownAi(view)) change.ai = draft.ai ? false : null
    try {
      const r = await api.setPermissions(folder, change, view.etag)
      onChanged()
      if (!('access' in r)) return onAccessLost()
      if (then === 'close') return onClose()
      show(r)
      setNotice(t('perm.saved'))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'precondition_failed') {
        // vihko.yaml changed meanwhile (another person, an editor): what it says now, and nothing was saved.
        await load()
        setNotice(null)
        setUnsaved(null)
        setError(t('perm.stale'))
      } else fail(err)
    }
    setBusy(false)
  }

  const add = () => {
    if (!adding.subject) return
    setGrants({ ...grants, [adding.subject]: adding.level })
    setAdding({ subject: '', level: 'read' })
  }

  const spaceName = view?.space?.name ?? (view?.space ? labels.space(view.space.path) : '')
  const title = !view ? t('perm.title', { name: baseName(folder) })
    : isSpaceRoot ? t('spaces.membersOf', { name: spaceName })
    : personalRoot ? t('spaces.agentsTitle')
    : t('perm.title', { name: baseName(folder) })
  const nobody = !!view && view.owner !== null && subjects.length === 0 && view.inherited.length === 0
  const rowLabel = (s: string) => t('perm.levelOf', { who: s })
  return (
    <Dialog className="dialog perm-dialog" aria-label={title}>
      <div className="dialog-fields">
        <div>
          <Heading slot="title" className="dialog-title">{title}</Heading>
          <p className="perm-path">{labels.label(folder)}</p>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        {!view ? (!error && <p className="hint">{t('common.loading')}</p>) : (
          <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k === 'access' ? 'access' : 'grants')}>
            <TabList className="cfg-tabs" aria-label={t('perm.tabs')}>
              <Tab id="grants" className="cfg-tab">{t(isSpaceRoot ? 'spaces.membersTab' : 'perm.tabGrants')}</Tab>
              <Tab id="access" className="cfg-tab">{t('perm.tabAccess')}</Tab>
            </TabList>
            <TabPanel id="grants" className="cfg-panel perm-panel">
              {view.section === 'closed' && <p className="key-locked" role="note">{Icon.alert}<span>{t('perm.sectionClosed')}</span></p>}
              {readOnly && view.section !== 'closed' && <p className="hint">{t('perm.readOnly')}</p>}
              {personalRoot ? (
                <p className="perm-nobody">{Icon.lock}<span>{t('perm.personalRoot')}</span></p>
              ) : (<>
                {view.inherited.map((i) => (
                  <div key={i.from} className="perm-inherited">
                    <p className="perm-origin"><span className="perm-origin-text">{t('perm.byFolder', { folder: labels.label(i.from) })}</span></p>
                    <ul className="perm-rows" aria-label={t('perm.byFolder', { folder: labels.label(i.from) })}>
                      {Object.keys(i.grants).sort(sortSubjects).map((s) => (
                        <li key={s} className="perm-row">
                          <Subject subject={s} me={me.username} />
                          <span className="perm-row-level"><span className="perm-level-text">{t(LEVEL_LABEL[i.grants[s]!])}</span></span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {view.inherited.length > 0 && <p className="perm-origin"><span className="perm-origin-text"><strong>{t(isSpaceRoot ? 'spaces.membersTab' : 'perm.here')}</strong></span></p>}
                {nobody ? (
                  <p className="perm-nobody">{Icon.lock}<span>{t('perm.onlyYou')}</span></p>
                ) : subjects.length === 0 ? (
                  <p className="perm-nobody"><span>{t(isSpaceRoot ? 'perm.noMembers' : 'perm.noneHere')}</span></p>
                ) : (
                  <ul className="perm-rows" aria-label={t('perm.rows')}>
                    {subjects.map((s) => (
                      <li key={s} className="perm-row">
                        <Subject subject={s} me={me.username} />
                        {!readOnly ? (<>
                          <LevelSelect value={grants[s]!} label={rowLabel(s)} from={above.get(key(s)) ?? null} onChange={(l) => setGrants({ ...grants, [s]: l })} />
                          {!ownRow(s) ? (
                            <Button className="btn btn-icon btn-quiet perm-remove" aria-label={t('perm.remove', { who: s })} onPress={() => { const next = { ...grants }; delete next[s]; setGrants(next) }}>{Icon.close}</Button>
                          ) : canLeave ? (
                            <Button className="btn btn-quiet perm-leave" onPress={requestLeave}>{t('spaces.leave')}</Button>
                          ) : <span className="perm-remove" aria-hidden="true" />}
                        </>) : (
                          <span className="perm-row-level"><span className="perm-level-text">{t(LEVEL_LABEL[grants[s]!])}</span></span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!readOnly && (
                  <div className="perm-add">
                    <select className="select perm-add-who" aria-label={t('perm.addWho')} value={adding.subject} onChange={(e) => setAdding({ ...adding, subject: e.target.value })}>
                      <option value="">{t('perm.addPick')}</option>
                      {candidates.users.length > 0 && <optgroup label={t('perm.people')}>{candidates.users.map((u) => <option key={u} value={u}>{u}</option>)}</optgroup>}
                      {candidates.groups.length > 0 && <optgroup label={t('perm.groups')}>{candidates.groups.map((g) => <option key={g} value={`@${g}`}>@{g}</option>)}</optgroup>}
                    </select>
                    <LevelSelect value={adding.level} label={t('perm.addLevel')} from={addFrom} onChange={(level) => setAdding({ ...adding, level })} />
                    <Button className="btn" isDisabled={!adding.subject} onPress={add}>{Icon.plus}{t('perm.add')}</Button>
                  </div>
                )}
                {losesManage && <p className="key-once" role="note">{Icon.alert}<span>{t('perm.losesManage')}</span></p>}
                {probes && <p className="key-once" role="note">{Icon.alert}<span>{t('perm.editProbes')}</span></p>}
                <p className="perm-cascade">{t('perm.onlyAdds')}</p>
                {inner && (toNewSpace || toMine) && (
                  <div className="perm-move">
                    <p className="hint">{t('perm.whyNotClose')}</p>
                    <div className="perm-move-actions">
                      {toNewSpace && <Button className="btn" onPress={() => onMoveTo!('newSpace')}>{t('folder.toNewSpace')}</Button>}
                      {toMine && <Button className="btn" onPress={() => onMoveTo!('mine')}>{t('folder.toMine')}</Button>}
                    </div>
                  </div>
                )}
                <p className="hint">{t('perm.levels')}</p>
              </>)}
              <div className="switches perm-agents">
                <Toggle label={t('perm.aiTitle')}
                  hint={aiFromAbove ? t('perm.aiFrom', { folder: labels.label(view.ai.from ?? '') }) : t('perm.aiHint')}
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
      {notice && !unsaved && <p className="perm-notice dialog-error" role="status">{notice}</p>}
      {unsaved ? (
        // Changes not saved: said before they're lost, with the three ways out.
        <div className="perm-unsaved" role="alertdialog" aria-labelledby="perm-unsaved-text">
          <p id="perm-unsaved-text" className="key-once">{Icon.alert}<span>{t('perm.unsaved')}</span></p>
          <div className="dialog-actions">
            <Button className="btn" autoFocus onPress={() => setUnsaved(null)}>{t('perm.keepEditing')}</Button>
            <Button className="btn btn-danger" onPress={() => { const then = unsaved; setUnsaved(null); if (then === 'leave') onLeave!(leaveKind, leaveName()); else onClose() }}>{t('perm.discard')}</Button>
            {unsaved === 'close' && <Button className="btn btn-primary" isDisabled={busy} onPress={() => void save('close')}>{t('perm.saveAndClose')}</Button>}
          </div>
        </div>
      ) : (
        <div className="dialog-actions">
          <Button className="btn" onPress={requestClose}>{t(dirty ? 'common.cancel' : 'perm.close')}</Button>
          {view && !readOnly && <Button className="btn btn-primary" isDisabled={!dirty || busy} onPress={() => void save()}>{t('perm.save')}</Button>}
        </div>
      )}
    </Dialog>
  )
}

/** Who can read, comment, edit or manage a folder, and why (saved permissions). */
export function FolderAccess({ view }: { view: FolderPermissions }) {
  const t = useT()
  const labels = usePathLabels()
  const rows = [...view.access].sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || collator.compare(a.username, b.username))
  return (
    <>
      <p className="hint">{t('perm.accessIntro')}</p>
      {rows.length === 0 ? <p className="perm-nobody">{Icon.lock}<span>{t('perm.nobodyAtAll')}</span></p> : (
        <ul className="perm-rows" aria-label={t('perm.tabAccess')}>
          {rows.map((a) => (
            <li key={a.id} className="perm-row perm-row-access">
              <span className="perm-subject">
                <span className="perm-avatar" aria-hidden="true">{a.username.slice(0, 1).toUpperCase()}</span>
                <span className="perm-name">{a.username}</span>
              </span>
              <span className="perm-row-level">
                <span className="perm-level-text">{t(LEVEL_LABEL[a.level])}</span>
                {a.via.map((v, i) => <span key={i} className="perm-row-from">{viaText(t, v, a.username, labels.label)}</span>)}
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
      // Not `people` nor `spaces`: a space's root is where the tree starts.
      for (let n = 2; n < parts.length; n++) all.add(parts.slice(0, n).join('/'))
    }
  }
  const sorted = [...all].sort((a, b) => {
    const pa = a.split('/'), pb = b.split('/')
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const c = collator.compare(pa[i]!, pb[i]!)
      if (c) return c
    }
    return pa.length - pb.length
  })
  return sorted.map((f) => ({ folder: f, depth: Math.max(0, f.split('/').length - 2), item: byPath.get(f) ?? null }))
}

/** Which folders a person or a key reaches, as a tree, with the level in each. */
export function AccessTree({ access }: { access: EffectiveAccess }) {
  const t = useT()
  // Someone else's access (the admin looking): every personal space by its owner's name, never «My notes».
  const ctx = useSpaces()
  const labels = usePathLabels(useSpacesValue(access.user.username === ctx.me ? ctx.me : '', ctx.info))
  const rows = treeRows(access.folders.filter((f) => f.folder.split('/').length >= 2))
  if (rows.length === 0) return <p className="perm-nobody">{Icon.lock}<span>{t('perm.seesNothing')}</span></p>
  return (
    <ul className="access-tree" aria-label={t('perm.accessTree')}>
      {rows.map((r) => (
        <li key={r.folder} className={`access-row${r.item ? '' : ' access-row-path'}`} style={{ paddingLeft: `calc(${r.depth} * var(--space-4) + var(--space-3))` }}>
          <span className="access-icon" aria-hidden="true">{Icon.folder}</span>
          <span className="access-name">{r.depth === 0 ? labels.space(r.folder) || r.folder : baseName(r.folder)}</span>
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

/** The marks of a folder shared with someone, or closed to agents (tree and lists). */
export function LockBadges({ own, ai }: { own: boolean; ai: boolean }) {
  const t = useT()
  if (!own && !ai) return null
  return (
    <span className="lock-badges">
      {own && <span className="lock-badge" role="img" aria-label={t('perm.lockOwn')} title={t('perm.lockOwn')}>{Icon.people}</span>}
      {ai && <span className="lock-badge lock-badge-ai" role="img" aria-label={t('perm.lockAi')} title={t('perm.lockAi')}>{Icon.eyeOff}</span>}
    </span>
  )
}

/**
 * Who has access to a space or a folder shared with the person, read-only:
 * every member sees who the others are and at what level, and
 * why (their own grant, a group, the owner's space). Where a grant comes
 * from a folder the person doesn't read, only that it comes from above.
 */
export function MembersDialog({ path, me, onClose, onUnauthorized }: { path: string; me: User; onClose: () => void; onUnauthorized: () => void }) {
  const t = useT()
  const labels = usePathLabels()
  const [view, setView] = useState<MembersView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.members(path).then(setView).catch((err) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setError(errorText(t, err))
    })
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  const root = !!view?.space && view.space.path === view.path
  const title = root ? t('spaces.membersOf', { name: view!.space!.name }) : t('spaces.accessTitle', { name: baseName(path) })
  const why = (v: MembersView['members'][number]['via'][number], username: string) => {
    if (v.owner) return t('perm.viaOwner')
    const through = key(v.subject) === key(username) ? t('perm.viaDirect') : t('perm.viaGroup', { group: v.subject })
    return `${through} · ${v.from === null ? t('perm.viaAbove') : t('perm.viaFolder', { folder: labels.label(v.from) })}`
  }
  const rows = [...(view?.members ?? [])].sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || collator.compare(a.username, b.username))
  return (
    <Dialog className="dialog perm-dialog" aria-label={title}>
      <div className="dialog-fields">
        <div>
          <Heading slot="title" className="dialog-title">{title}</Heading>
          <p className="perm-path">{labels.label(path)}</p>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        {!view ? (!error && <p className="hint">{t('common.loading')}</p>) : (<>
          <ul className="perm-rows" aria-label={title}>
            {rows.map((a) => (
              <li key={a.username} className="perm-row perm-row-access">
                <Subject subject={a.username} me={me.username} />
                <span className="perm-row-level">
                  <span className="perm-level-text">{t(LEVEL_LABEL[a.level])}</span>
                  {a.via.map((v, i) => <span key={i} className="perm-row-from">{why(v, a.username)}</span>)}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">{t(root ? 'spaces.membersReadOnly' : 'spaces.accessReadOnly')}</p>
        </>)}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('perm.close')}</Button>
      </div>
    </Dialog>
  )
}
