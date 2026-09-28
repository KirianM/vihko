// Settings → «Users and groups» (the vihko admin, D-038.3 and .8): everyone
// in a table with filters, and what can be done to each (a link to join or
// to reset the password, copied once; role; close sessions; disable, enable
// and delete), each confirmation saying what it does. Groups, which the
// admin creates and fills. And the admin's settings: members downloading
// images from the local network (D-038.6) and the second factor's policy
// (D-036: required, optional or disabled), whose state each person's row
// shows and the admin can reset. What lets the admin into someone else's
// account (a reset link, their second factor's reset, a new role), a new
// admin and a new policy ask for the confirmation at the moment, the admin's
// own code or password (D-040 3.1, 3.4a, D-046.1); the person and the other
// admins are told.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, Heading, Input, Label, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Text, TextField } from 'react-aria-components'
import { ApiError, api, type AdminSettings, type GroupInfo, type NewLink, type TwoFactorPolicy, type User, type UserInfo } from './api.ts'
import { CopyButton, Toggle } from './Agents.tsx'
import { ConfirmField, codeError, useConfirmWith } from './TwoFactor.tsx'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { useDates } from './history/ui.tsx'
import { AdminPurge } from './history/Purge.tsx'
import { AccessDialog, FolderPermissionsList, PermissionsDialog } from './Permissions.tsx'
import { SearchButton } from './Palette.tsx'
import { Icon, MenuButton, ThemeToggle } from './ui.tsx'
import './actions.css'
import './agents.css'
import './users.css'

type Filter = 'all' | UserInfo['status']
const FILTERS: { id: Filter; label: MessageKey }[] = [
  { id: 'all', label: 'users.filterAll' },
  { id: 'active', label: 'users.filterActive' },
  { id: 'invited', label: 'users.filterInvited' },
  { id: 'disabled', label: 'users.filterDisabled' },
]

/** What a confirmation does: its title, the consequences it lists and its button. */
type Action = 'disable' | 'delete' | 'promote' | 'demote' | 'sessions' | 'link' | 'twoFactor'

const POLICIES: { id: TwoFactorPolicy; label: MessageKey; hint: MessageKey }[] = [
  { id: 'optional', label: 'users.tfOptional', hint: 'users.tfOptionalHint' },
  { id: 'required', label: 'users.tfRequired', hint: 'users.tfRequiredHint' },
  { id: 'disabled', label: 'users.tfDisabled', hint: 'users.tfDisabledHint' },
]

type Open =
  | { kind: 'new' }
  | { kind: 'link'; user: UserInfo; link: NewLink; created: boolean }
  | { kind: 'confirm'; action: Action; user: UserInfo }
  | { kind: 'policy'; policy: TwoFactorPolicy }
  | { kind: 'newGroup' }
  | { kind: 'renameGroup'; group: GroupInfo }
  | { kind: 'deleteGroup'; group: GroupInfo }
  | { kind: 'access'; user: UserInfo }
  | { kind: 'permissions'; folder: string }

const linkUrl = (l: NewLink) => l.url ?? `${location.origin}${l.path}`

/**
 * A new user: a name and a role; then the link to send them. A new admin is
 * confirmed at the moment, as making someone admin is (D-046.1).
 */
function NewUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (user: UserInfo, link: NewLink) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [role, setRole] = useState<UserInfo['role']>('member')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needsSecret = role === 'admin' && !secret.trim()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !name.trim() || needsSecret) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.createUser(name.trim(), role, role === 'admin' ? secret.trim() : undefined)
      onCreated(r.user, r.link)
    } catch (err) {
      setError(codeError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('users.newTitle')}</Heading>
          <TextField className="field" value={name} onChange={setName} maxLength={64} isRequired autoFocus>
            <Label>{t('field.username')}</Label>
            <Input autoComplete="off" />
            <Text slot="description" className="hint">{t('users.nameHint')}</Text>
          </TextField>
          <fieldset className="key-fieldset">
            <legend>{t('users.role')}</legend>
            <label className="check">
              <input type="radio" name="role" checked={role === 'member'} onChange={() => setRole('member')} />
              <span className="check-text">{t('users.roleMember')}<span className="hint">{t('users.roleMemberHint')}</span></span>
            </label>
            <label className="check">
              <input type="radio" name="role" checked={role === 'admin'} onChange={() => setRole('admin')} />
              <span className="check-text">{t('users.roleAdmin')}<span className="hint">{t('users.roleAdminHint')}</span></span>
            </label>
          </fieldset>
          {role === 'admin' && <IdentityField value={secret} onChange={setSecret} hint={t('users.newAdminHint')} />}
          <p className="dialog-text">{t('users.newBody')}</p>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !name.trim() || needsSecret}>{t('users.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** The link, shown this once: copy it and send it. */
function LinkDialog({ user, link, created, onClose }: { user: UserInfo; link: NewLink; created: boolean; onClose: () => void }) {
  const t = useT()
  const dates = useDates()
  const url = linkUrl(link)
  const title: MessageKey = link.kind === 'reset' ? 'users.linkResetTitle' : created ? 'users.linkCreatedTitle' : 'users.linkInviteTitle'
  return (
    <Dialog className="dialog key-dialog" aria-label={t(title, { user: user.username })}>
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t(title, { user: user.username })}</Heading>
        <p className="dialog-text">{t(link.kind === 'reset' ? 'users.linkResetBody' : 'users.linkInviteBody', { user: user.username, date: dates.dateTime(link.expiresAt) })}</p>
        <p className="key-once" role="note">{Icon.alert}<span>{t('users.linkOnce')}</span></p>
        <div className="token-row">
          <code className="token" aria-label={t('users.linkLabel')} tabIndex={0}>{url}</code>
          <CopyButton text={url} label={t('users.copyLink')} primary />
        </div>
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose}>{t('users.linkDone')}</Button>
      </div>
    </Dialog>
  )
}

/** The admin's own code (or password) that confirms a change at the moment. */
function IdentityField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  const how = useConfirmWith()
  return <ConfirmField how={how} value={value} onChange={onChange} hint={hint} />
}

/**
 * A confirmation that lists what happens. With `identity` (a hint), it also
 * asks for the admin's current code or password, which `onConfirm` gets.
 */
function ConfirmDialog({ title, items, confirm, danger, identity, onClose, onConfirm }: {
  title: string
  items: string[]
  confirm: string
  danger?: boolean
  identity?: string
  onClose: () => void
  onConfirm: (secret: string) => Promise<void>
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState('')
  const go = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy || (identity && !secret.trim())) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(secret.trim())
    } catch (err) {
      setError(codeError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <form onSubmit={(e) => void go(e)}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{title}</Heading>
          <ul className="consequences">{items.map((x) => <li key={x}>{x}</li>)}</ul>
          {identity && <IdentityField value={secret} onChange={setSecret} hint={identity} />}
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose} autoFocus={!identity}>{t('common.cancel')}</Button>
          <Button type="submit" className={danger ? 'btn btn-danger' : 'btn btn-primary'} isDisabled={busy || (!!identity && !secret.trim())}>{confirm}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** A group's name: new, or renamed. */
function GroupNameDialog({ group, onClose, onSaved }: { group: GroupInfo | null; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const [name, setName] = useState(group?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (group) await api.renameGroup(group.id, name.trim())
      else await api.createGroup(name.trim())
      onSaved()
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{group ? t('groups.renameTitle', { name: group.name }) : t('groups.newTitle')}</Heading>
          <TextField className="field" value={name} onChange={setName} maxLength={64} isRequired autoFocus>
            <Label>{t('groups.name')}</Label>
            <Input autoComplete="off" />
            <Text slot="description" className="hint">{t(group ? 'groups.renameHint' : 'groups.nameHint')}</Text>
          </TextField>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !name.trim()}>{t(group ? 'groups.rename' : 'groups.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

function StatusPill({ u }: { u: UserInfo }) {
  const t = useT()
  const dates = useDates()
  const label: MessageKey = u.status === 'active' ? 'users.statusActive' : u.status === 'invited' ? 'users.statusInvited' : 'users.statusDisabled'
  return (
    <span className="user-status-cell">
      <span className={`user-status user-status-${u.status}`}>{t(label)}</span>
      {u.status === 'invited' && (
        <span className="hint">{u.link ? t('users.linkUntil', { date: dates.dateTime(u.link.expiresAt) }) : t('users.linkNone')}</span>
      )}
    </span>
  )
}

/** One group: its members (removable), a way to add one, rename and delete. */
function GroupCard({ group, users, busy, onAdd, onRemove, onRename, onDelete }: {
  group: GroupInfo
  users: UserInfo[]
  busy: boolean
  onAdd: (userId: string) => void
  onRemove: (userId: string, username: string) => void
  onRename: () => void
  onDelete: () => void
}) {
  const t = useT()
  const outside = users.filter((u) => !group.members.some((m) => m.id === u.id))
  return (
    <li className="group-card">
      <div className="key-head">
        <h3 className="group-name">@{group.name}</h3>
        <span className="key-owner">{t(group.members.length === 1 ? 'groups.membersOne' : 'groups.members', { n: group.members.length })}</span>
      </div>
      {group.members.length > 0 ? (
        <ul className="group-members" aria-label={t('groups.membersOf', { name: group.name })}>
          {group.members.map((m) => (
            <li key={m.id} className="member-chip">
              <span>{m.username}</span>
              <Button className="chip-remove" aria-label={t('groups.remove', { user: m.username, name: group.name })} isDisabled={busy} onPress={() => onRemove(m.id, m.username)}>{Icon.close}</Button>
            </li>
          ))}
        </ul>
      ) : <p className="hint">{t('groups.empty')}</p>}
      <div className="key-actions">
        {outside.length > 0 && (
          <select className="select group-add" aria-label={t('groups.addTo', { name: group.name })} value="" disabled={busy}
            onChange={(e) => { if (e.target.value) onAdd(e.target.value) }}>
            <option value="">{t('groups.add')}</option>
            {outside.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
        )}
        <Button className="btn" onPress={onRename}>{t('groups.rename')}</Button>
        <Button className="btn btn-danger" onPress={onDelete}>{t('groups.delete')}</Button>
      </div>
    </li>
  )
}

export function UsersPage({ user: me, onUnauthorized }: { user: User; onUnauthorized: () => void }) {
  const t = useT()
  const dates = useDates()
  const [users, setUsers] = useState<UserInfo[] | null>(null)
  const [groups, setGroups] = useState<GroupInfo[] | null>(null)
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Open | null>(null)
  /** The folders' list again after a permissions change. */
  const [foldersSeq, setFoldersSeq] = useState(0)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }
  const load = () => Promise.all([api.users().then(setUsers), api.groups().then(setGroups), api.adminSettings().then(setSettings)]).catch(fail)
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => setOpen(null)
  const done = () => { close(); void load() }
  /** An action straight away (no confirmation needed), then everything again. */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (err) { fail(err) }
    setBusy(false)
    void load()
  }

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, active: 0, invited: 0, disabled: 0 }
    for (const u of users ?? []) { c.all++; c[u.status]++ }
    return c
  }, [users])
  const q = query.trim().toLowerCase()
  const shown = (users ?? []).filter((u) => (filter === 'all' || u.status === filter) && (!q || u.username.toLowerCase().includes(q)))
  // The second factor's column: also while it's off for new setups, whoever has one keeps it.
  const policy = settings?.twoFactor ?? 'optional'
  const twoFactor = settings !== null
  const twoFactorCell = (u: UserInfo) => {
    if (u.twoFactor.enabled) return <span className="user-status user-status-active" title={u.twoFactor.enabledAt ? t('users.tfSince', { date: dates.dateTime(u.twoFactor.enabledAt) }) : undefined}>{t('users.tfOn')}</span>
    if (policy === 'required' && u.status !== 'disabled') return <span className="hint">{t('users.tfAtSignIn')}</span>
    return <span className="hint">{t('users.tfOff')}</span>
  }

  const actions = (u: UserInfo) => {
    const items: { id: string; label: string; danger?: boolean }[] = [{ id: 'access', label: t('perm.userAccessAction') }]
    if (u.id === me.id) return items
    if (u.status !== 'disabled') items.push({ id: 'link', label: t(u.status === 'invited' ? 'users.actionInviteLink' : 'users.actionResetLink') })
    items.push({ id: u.role === 'admin' ? 'demote' : 'promote', label: t(u.role === 'admin' ? 'users.actionDemote' : 'users.actionPromote') })
    if (u.sessions > 0) items.push({ id: 'sessions', label: t('users.actionSessions', { n: u.sessions }) })
    if (u.twoFactor.enabled) items.push({ id: 'twoFactor', label: t('users.actionTwoFactor') })
    if (u.status === 'disabled') {
      items.push({ id: 'enable', label: t('users.actionEnable') })
      items.push({ id: 'delete', label: t('users.actionDelete'), danger: true })
    } else items.push({ id: 'disable', label: t('users.actionDisable'), danger: true })
    return items
  }
  const onAction = (u: UserInfo, id: string) => {
    if (id === 'enable') return void run(() => api.enableUser(u.id))
    if (id === 'access') return setOpen({ kind: 'access', user: u })
    setOpen({ kind: 'confirm', action: id as Action, user: u })
  }

  const confirmFor = (action: Action, u: UserInfo): { title: string; items: string[]; confirm: string; danger?: boolean; identity?: string; go: (secret: string) => Promise<void> } => {
    const user = u.username
    /** Into someone else's account: confirmed at the moment, and told (D-040 3.1). */
    const told = t('users.told', { user })
    const identity = t('users.confirmIdentityHint')
    switch (action) {
      case 'disable': return {
        title: t('users.disableTitle', { user }), danger: true, confirm: t('users.disableConfirm'),
        items: [t('users.disable1'), t('users.disable2'), t('users.disable3')],
        go: async () => { await api.disableUser(u.id); done() },
      }
      case 'delete': return {
        title: t('users.deleteTitle', { user }), danger: true, confirm: t('users.deleteConfirm'),
        items: [t('users.delete1'), t('users.delete2'), t('users.delete3'), t('users.delete4'), t('users.delete5')],
        go: async () => { await api.deleteUser(u.id); done() },
      }
      case 'promote': return {
        title: t('users.promoteTitle', { user }), confirm: t('users.promoteConfirm'),
        items: [t('users.promote1'), t('users.promote2'), told], identity,
        go: async (secret) => { await api.setRole(u.id, 'admin', secret); done() },
      }
      case 'demote': return {
        title: t('users.demoteTitle', { user }), confirm: t('users.demoteConfirm'),
        items: [t('users.demote1'), t('users.demote2'), told], identity,
        go: async (secret) => { await api.setRole(u.id, 'member', secret); done() },
      }
      case 'sessions': return {
        title: t('users.sessionsTitle', { user }), danger: true, confirm: t('users.sessionsConfirm'),
        items: [t(u.sessions === 1 ? 'users.sessions1One' : 'users.sessions1', { n: u.sessions }), t('users.sessions2')],
        go: async () => { await api.endUserSessions(u.id); done() },
      }
      case 'twoFactor': return {
        title: t('users.tfResetTitle', { user }), danger: true, confirm: t('users.tfResetConfirm'),
        items: [t(policy === 'required' ? 'users.tfReset1Required' : 'users.tfReset1'), t('users.tfReset2'), t('users.tfReset3'), told], identity,
        go: async (secret) => { await api.resetTwoFactor(u.id, secret); done() },
      }
      case 'link': {
        const reset = u.status !== 'invited'
        return {
          title: t(reset ? 'users.resetTitle' : 'users.relinkTitle', { user }), confirm: t('users.linkConfirm'),
          items: reset ? [t('users.reset1'), t('users.reset2'), t('users.linkEnds'), told] : [t('users.relink1'), t('users.linkEnds')],
          ...(reset ? { identity } : {}),
          go: async (secret) => {
            const r = await api.userLink(u.id, reset ? secret : undefined)
            setOpen({ kind: 'link', user: r.user, link: r.link, created: false })
            void load()
          },
        }
      }
    }
  }

  const groupRun = (fn: () => Promise<unknown>) => void run(fn)

  let dialog: ReactNode = null
  if (open?.kind === 'new') dialog = <NewUserDialog onClose={close} onCreated={(user, link) => { setOpen({ kind: 'link', user, link, created: true }); void load() }} />
  else if (open?.kind === 'link') dialog = <LinkDialog user={open.user} link={open.link} created={open.created} onClose={close} />
  else if (open?.kind === 'confirm') {
    const c = confirmFor(open.action, open.user)
    dialog = <ConfirmDialog key={`${open.action}-${open.user.id}`} title={c.title} items={c.items} confirm={c.confirm} danger={c.danger} identity={c.identity} onClose={close} onConfirm={c.go} />
  } else if (open?.kind === 'policy') {
    const p = POLICIES.find((x) => x.id === open.policy)!
    dialog = <ConfirmDialog key={`policy-${p.id}`} title={t('users.tfPolicyTitle', { policy: t(p.label) })} items={[t(p.hint)]} confirm={t('users.tfPolicyConfirm')}
      identity={t('users.tfPolicyHint')} onClose={close}
      onConfirm={async (secret) => { setSettings(await api.setAdminSettings({ twoFactor: p.id, confirm: secret })); close() }} />
  } else if (open?.kind === 'newGroup' || open?.kind === 'renameGroup') {
    dialog = <GroupNameDialog group={open.kind === 'renameGroup' ? open.group : null} onClose={close} onSaved={done} />
  } else if (open?.kind === 'deleteGroup') {
    const g = open.group
    dialog = <ConfirmDialog title={t('groups.deleteTitle', { name: g.name })} danger confirm={t('groups.deleteConfirm')}
      items={[t('groups.delete1', { name: g.name }), t('groups.delete2')]} onClose={close}
      onConfirm={async () => { await api.deleteGroup(g.id); done() }} />
  } else if (open?.kind === 'access') {
    dialog = <AccessDialog who={{ user: open.user.id }} title={t('perm.userAccessTitle', { user: open.user.username })} onClose={close} onUnauthorized={onUnauthorized} />
  } else if (open?.kind === 'permissions') {
    dialog = <PermissionsDialog folder={open.folder} me={me} canOpen={() => true} onClose={close}
      onChanged={() => setFoldersSeq((n) => n + 1)} onAccessLost={close} onUnauthorized={onUnauthorized} />
  }

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="alerts-page settings-page users-page">
        <h1>{t('users.title')}</h1>
        <p className="alerts-intro">{t('users.intro')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}

        <section className="settings-section users-section" aria-labelledby="users-list">
          <div className="settings-head">
            <h2 id="users-list">{t('users.list')}</h2>
            <span className="spacer" />
            <Button className="btn btn-primary" onPress={() => setOpen({ kind: 'new' })}>{Icon.plus}{t('users.new')}</Button>
          </div>
          <div className="users-toolbar">
            <div className="users-filters" role="group" aria-label={t('users.filter')}>
              {FILTERS.map((f) => (
                <Button key={f.id} className="filter-chip" aria-pressed={filter === f.id} onPress={() => setFilter(f.id)}>
                  {t(f.label)}<span className="filter-count">{counts[f.id]}</span>
                </Button>
              ))}
            </div>
            <TextField className="field users-search" value={query} onChange={setQuery} aria-label={t('users.search')}>
              <Input placeholder={t('users.search')} />
            </TextField>
          </div>
          {users === null ? <p className="hint">{t('common.loading')}</p> : shown.length === 0 ? <p className="hint">{t('users.none')}</p> : (
            <div className="users-table-wrap">
              <table className="users-table">
                <thead>
                  <tr>
                    <th scope="col">{t('users.colUser')}</th>
                    <th scope="col">{t('users.colStatus')}</th>
                    <th scope="col">{t('users.colRole')}</th>
                    <th scope="col">{t('users.colGroups')}</th>
                    {twoFactor && <th scope="col">{t('users.colTwoFactor')}</th>}
                    <th scope="col">{t('users.colSeen')}</th>
                    <th scope="col"><span className="visually-hidden">{t('users.colActions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((u) => (
                    <tr key={u.id} className={u.status === 'disabled' ? 'user-row-disabled' : undefined}>
                      <th scope="row" className="user-name">
                        {u.username}
                        {u.id === me.id && <span className="user-you">{t('users.you')}</span>}
                      </th>
                      <td><StatusPill u={u} /></td>
                      <td>{t(u.role === 'admin' ? 'users.roleAdmin' : 'users.roleMember')}</td>
                      <td>{u.groups.length ? <span className="user-groups">{u.groups.map((g) => <span key={g} className="group-tag">@{g}</span>)}</span> : <span className="hint">—</span>}</td>
                      {twoFactor && <td>{twoFactorCell(u)}</td>}
                      <td>{u.lastSeenAt ? dates.dateTime(u.lastSeenAt) : <span className="hint">{t('users.never')}</span>}</td>
                      <td className="user-actions">
                        <MenuTrigger>
                          <Button className="btn btn-icon" aria-label={t('users.actionsFor', { user: u.username })} isDisabled={busy}>{Icon.more}</Button>
                          <Popover className="menu-popover" placement="bottom end">
                            <Menu className="menu" onAction={(key) => onAction(u, String(key))}>
                              {actions(u).map((a) => <MenuItem key={a.id} id={a.id} className={a.danger ? 'menu-item menu-item-danger' : 'menu-item'}>{a.label}</MenuItem>)}
                            </Menu>
                          </Popover>
                        </MenuTrigger>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="settings-section" aria-labelledby="users-groups">
          <div className="settings-head">
            <h2 id="users-groups">{t('groups.title')}</h2>
            <span className="spacer" />
            <Button className="btn" onPress={() => setOpen({ kind: 'newGroup' })}>{Icon.plus}{t('groups.new')}</Button>
          </div>
          <p className="hint">{t('groups.intro')}</p>
          {groups === null ? <p className="hint">{t('common.loading')}</p> : groups.length === 0 ? <p className="hint">{t('groups.none')}</p> : (
            <ul className="keys">
              {groups.map((g) => (
                <GroupCard key={g.id} group={g} users={users ?? []} busy={busy}
                  onAdd={(id) => groupRun(() => api.addMember(g.id, id))}
                  onRemove={(id) => groupRun(() => api.removeMember(g.id, id))}
                  onRename={() => setOpen({ kind: 'renameGroup', group: g })}
                  onDelete={() => setOpen({ kind: 'deleteGroup', group: g })} />
              ))}
            </ul>
          )}
        </section>

        <section className="settings-section" aria-labelledby="users-folders">
          <h2 id="users-folders">{t('perm.foldersTitle')}</h2>
          <p className="hint">{t('perm.foldersIntro')}</p>
          <FolderPermissionsList refresh={foldersSeq} onOpen={(folder) => setOpen({ kind: 'permissions', folder })} onUnauthorized={onUnauthorized} />
        </section>

        <section className="settings-section" aria-labelledby="users-settings">
          <h2 id="users-settings">{t('users.settings')}</h2>
          {settings === null ? <p className="hint">{t('common.loading')}</p> : (
            <div className="switches">
              <Toggle label={t('users.localDownloads')} hint={t('users.localDownloadsHint')} value={settings.membersLocalDownloads} disabled={busy}
                onChange={(v) => void run(async () => setSettings(await api.setAdminSettings({ membersLocalDownloads: v })))} />
              <fieldset className="key-fieldset">
                <legend>{t('users.tfPolicy')}</legend>
                {POLICIES.map((p) => (
                  <label key={p.id} className="check">
                    {/* A new policy is confirmed at the moment (D-040 3.4a): the radio shows what is in force until then. */}
                    <input type="radio" name="twoFactor" checked={settings.twoFactor === p.id} disabled={busy}
                      onChange={() => setOpen({ kind: 'policy', policy: p.id })} />
                    <span className="check-text">{t(p.label)}<span className="hint">{t(p.hint)}</span></span>
                  </label>
                ))}
              </fieldset>
            </div>
          )}
        </section>

        <AdminPurge />
      </div>
      <ModalOverlay className="modal-overlay" isOpen={open !== null} isDismissable={open?.kind !== 'link'} isKeyboardDismissDisabled={open?.kind === 'link'}
        onOpenChange={(o) => { if (!o) close() }}>
        <Modal className="modal">{dialog}</Modal>
      </ModalOverlay>
    </>
  )
}
