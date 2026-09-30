// Settings → «Spaces» (the vihko admin, D-056, spec §2.4, §2.6, §5.7): the
// directory of shared spaces (their names, who manages them and how many
// members: never what's inside), a manager for one that has none, the admin
// joining one (a member row like any other, told to its managers), who may
// create spaces, and what becomes of a deleted person's space (transfer it,
// make it a shared space, or delete it). Every change is confirmed at the
// moment with the admin's own code or password (D-040 3.1).
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, Heading, Input, Label, Modal, ModalOverlay, Text, TextField } from 'react-aria-components'
import { ApiError, LEVELS, api, type AdminSettings, type Alert, type ClosedSpace, type Grants, type Level, type PersonalSpacePlan, type SpaceInfo, type User, type UserInfo } from './api.ts'
import { ConfirmField, codeError, useConfirmWith } from './TwoFactor.tsx'
import { errorText, useT } from './i18n.tsx'
import { LEVEL_LABEL } from './Permissions.tsx'
import { SearchButton } from './Palette.tsx'
import { Icon, MenuButton, ThemeToggle } from './ui.tsx'
import './actions.css'
import './agents.css'
import './users.css'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

type Open =
  | { kind: 'manager'; space: SpaceInfo }
  | { kind: 'join'; space: SpaceInfo }
  | { kind: 'settle'; closed: ClosedSpace; action: PersonalSpacePlan['action'] }

/** The admin's own code (or password), with a hint of what it confirms. */
function Identity({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  const how = useConfirmWith()
  return <ConfirmField how={how} value={value} onChange={onChange} hint={hint} />
}

/** A dialog whose change is confirmed at the moment: its fields, then the admin's code or password. */
function ConfirmedDialog({ title, children, confirm, danger, ready = true, onClose, onConfirm }: {
  title: string
  children: ReactNode
  confirm: string
  danger?: boolean
  /** Whether what's asked is complete (a person picked…). */
  ready?: boolean
  onClose: () => void
  onConfirm: (secret: string) => Promise<void>
}) {
  const t = useT()
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !ready || !secret.trim()) return
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
      <form onSubmit={(e) => void submit(e)}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{title}</Heading>
          {children}
          <Identity value={secret} onChange={setSecret} hint={t('spacesAdmin.confirmHint')} />
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className={danger ? 'btn btn-danger' : 'btn btn-primary'} isDisabled={busy || !ready || !secret.trim()}>{confirm}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Making someone the manager of a space that has none: they and the other admins are told. */
function ManagerDialog({ space, users, onClose, onDone }: { space: SpaceInfo; users: UserInfo[]; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [who, setWho] = useState('')
  const active = users.filter((u) => u.status !== 'disabled').sort((a, b) => collator.compare(a.username, b.username))
  return (
    <ConfirmedDialog title={t('spacesAdmin.managerTitle', { name: space.name })} confirm={t('spacesAdmin.managerConfirm')} ready={!!who} onClose={onClose}
      onConfirm={async (secret) => { await api.assignManager(space.path, who, secret); onDone() }}>
      <p className="dialog-text">{t('spacesAdmin.managerBody')}</p>
      <label className="field">
        <span>{t('spacesAdmin.managerWho')}</span>
        <select className="select" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t('spacesAdmin.pick')}</option>
          {active.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
        </select>
      </label>
    </ConfirmedDialog>
  )
}

/** The admin joins a space: a member like any other, `read` by default; its managers are told. */
function JoinDialog({ space, onClose, onDone }: { space: SpaceInfo; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [level, setLevel] = useState<Level>('read')
  return (
    <ConfirmedDialog title={t('spacesAdmin.joinTitle', { name: space.name })} confirm={t('spacesAdmin.joinConfirm')} onClose={onClose}
      onConfirm={async (secret) => { await api.joinSpace(space.path, level, secret); onDone() }}>
      <ul className="consequences">
        <li>{t('spacesAdmin.join1')}</li>
        <li>{t('spacesAdmin.join2')}</li>
      </ul>
      <label className="field">
        <span>{t('spacesAdmin.joinLevel')}</span>
        <select className="select" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
          {LEVELS.map((l) => <option key={l} value={l}>{t(LEVEL_LABEL[l])}</option>)}
        </select>
      </label>
    </ConfirmedDialog>
  )
}

/**
 * What becomes of a deleted person's space: transfer it to someone, make it
 * a shared space with members (at least one who manages it), or delete it.
 * What it would do comes first (a dry run: counts, nothing named).
 */
function SettleDialog({ closed, action, users, groups, onClose, onDone }: {
  closed: ClosedSpace
  action: PersonalSpacePlan['action']
  users: UserInfo[]
  groups: string[]
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const [to, setTo] = useState('')
  const [name, setName] = useState(closed.username)
  const [members, setMembers] = useState<Grants>({})
  const [adding, setAdding] = useState<{ who: string; level: Level }>({ who: '', level: 'manage' })
  const [plan, setPlan] = useState<PersonalSpacePlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const input = { action, ...(action === 'transfer' ? { to } : {}), ...(action === 'convert' ? { name: name.trim(), members } : {}) }
  const ready = action === 'delete' || (action === 'transfer' ? !!to : !!name.trim() && Object.values(members).includes('manage'))
  const key = JSON.stringify(input)
  useEffect(() => {
    setPlan(null)
    setPlanError(null)
    if (!ready) return
    let live = true
    api.settleSpace(closed.userId, { ...input, dryRun: true })
      .then((p) => { if (live) setPlan(p) })
      .catch((err) => { if (live) setPlanError(errorText(t, err)) })
    return () => { live = false }
  }, [key, ready]) // eslint-disable-line react-hooks/exhaustive-deps
  const people = users.filter((u) => u.status !== 'disabled').sort((a, b) => collator.compare(a.username, b.username))
  const title = t(action === 'transfer' ? 'spacesAdmin.transferTitle' : action === 'convert' ? 'spacesAdmin.convertTitle' : 'spacesAdmin.deleteTitle', { user: closed.username })
  const counts = plan && [
    t(plan.notes === 1 ? 'folder.notesOne' : 'folder.notesMany', { n: plan.notes }),
    t(plan.files === 1 ? 'folder.filesOne' : 'folder.filesMany', { n: plan.files }),
  ].join(', ')
  return (
    <ConfirmedDialog title={title} danger={action === 'delete'} ready={ready && plan !== null} onClose={onClose}
      confirm={t(action === 'transfer' ? 'spacesAdmin.transferConfirm' : action === 'convert' ? 'spacesAdmin.convertConfirm' : 'spacesAdmin.deleteConfirm')}
      onConfirm={async (secret) => { await api.settleSpace(closed.userId, { ...input, confirm: secret }); onDone() }}>
      {action === 'transfer' && (
        <label className="field">
          <span>{t('spacesAdmin.transferTo')}</span>
          <select className="select" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t('spacesAdmin.pick')}</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
        </label>
      )}
      {action === 'convert' && (<>
        <TextField className="field" value={name} onChange={setName} maxLength={64} isRequired>
          <Label>{t('spaces.name')}</Label>
          <Input autoComplete="off" />
        </TextField>
        <fieldset className="key-fieldset">
          <legend>{t('spacesAdmin.convertMembers')}</legend>
          {Object.keys(members).length > 0 && (
            <ul className="group-members">
              {Object.entries(members).sort(([a], [b]) => collator.compare(a, b)).map(([s, l]) => (
                <li key={s} className="member-chip">
                  <span>{s} · {t(LEVEL_LABEL[l])}</span>
                  <Button className="chip-remove" aria-label={t('perm.remove', { who: s })} onPress={() => { const next = { ...members }; delete next[s]; setMembers(next) }}>{Icon.close}</Button>
                </li>
              ))}
            </ul>
          )}
          <div className="perm-add">
            <select className="select perm-add-who" aria-label={t('perm.addWho')} value={adding.who} onChange={(e) => setAdding({ ...adding, who: e.target.value })}>
              <option value="">{t('perm.addPick')}</option>
              <optgroup label={t('perm.people')}>{people.filter((u) => !(u.username in members)).map((u) => <option key={u.id} value={u.username}>{u.username}</option>)}</optgroup>
              {groups.length > 0 && <optgroup label={t('perm.groups')}>{groups.filter((g) => !(`@${g}` in members)).map((g) => <option key={g} value={`@${g}`}>@{g}</option>)}</optgroup>}
            </select>
            <select className="select perm-level" aria-label={t('perm.addLevel')} value={adding.level} onChange={(e) => setAdding({ ...adding, level: e.target.value as Level })}>
              {LEVELS.map((l) => <option key={l} value={l}>{t(LEVEL_LABEL[l])}</option>)}
            </select>
            <Button className="btn" isDisabled={!adding.who} onPress={() => { setMembers({ ...members, [adding.who]: adding.level }); setAdding({ who: '', level: 'edit' }) }}>{Icon.plus}{t('perm.add')}</Button>
          </div>
          <Text className="hint">{t('spacesAdmin.convertNeedsManager')}</Text>
        </fieldset>
      </>)}
      <ul className="consequences">
        {action === 'transfer' && <li>{t('spacesAdmin.transfer1', { user: closed.username })}</li>}
        {action === 'transfer' && <li>{t('spacesAdmin.transferLinks')}</li>}
        {action === 'convert' && <li>{t('spacesAdmin.convert1', { user: closed.username })}</li>}
        {action === 'delete' && <li>{t('spacesAdmin.delete1')}</li>}
        {action === 'delete' && <li>{t('spacesAdmin.delete2')}</li>}
        {plan && <li>{t('spacesAdmin.holds', { what: counts ?? '' })}</li>}
        {plan && plan.sharedFolders > 0 && <li>{t('spacesAdmin.shared', { folders: plan.sharedFolders, people: plan.people })}</li>}
      </ul>
      {!ready && <p className="hint">{t(action === 'transfer' ? 'spacesAdmin.pickSomeone' : 'spacesAdmin.convertNeedsManager')}</p>}
      {planError && <p className="error-text" role="alert">{planError}</p>}
    </ConfirmedDialog>
  )
}

export function SpacesPage({ user: me, onUnauthorized, onChanged }: { user: User; onUnauthorized: () => void; onChanged: () => void }) {
  const t = useT()
  const [spaces, setSpaces] = useState<SpaceInfo[] | null>(null)
  const [closed, setClosed] = useState<ClosedSpace[]>([])
  const [users, setUsers] = useState<UserInfo[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [open, setOpen] = useState<Open | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }
  const load = () => Promise.all([
    api.adminSpaces().then((r) => { setSpaces(r.spaces); setClosed(r.closed) }),
    api.users().then(setUsers),
    api.groups().then((g) => setGroups(g.map((x) => x.name))),
    api.adminSettings().then(setSettings),
    api.alerts().then(setAlerts).catch(() => {}),
  ]).catch(fail)
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => setOpen(null)
  const finished = (text: string) => { close(); setDone(text); onChanged(); void load() }
  const outside = alerts.find((a): a is Extract<Alert, { code: 'outside_spaces' }> => a.code === 'outside_spaces')
  const strays = alerts.find((a): a is Extract<Alert, { code: 'person_folder_without_user' }> => a.code === 'person_folder_without_user')
  const setCreation = async (v: AdminSettings['spacesCreation']) => {
    setBusy(true)
    setError(null)
    try { setSettings(await api.setAdminSettings({ spacesCreation: v })) } catch (err) { fail(err) }
    setBusy(false)
  }
  const sorted = [...(spaces ?? [])].sort((a, b) => collator.compare(a.name, b.name))

  let dialog: ReactNode = null
  if (open?.kind === 'manager') dialog = <ManagerDialog space={open.space} users={users} onClose={close} onDone={() => finished(t('spacesAdmin.managerDone', { name: open.space.name }))} />
  else if (open?.kind === 'join') dialog = <JoinDialog space={open.space} onClose={close} onDone={() => finished(t('spacesAdmin.joinDone', { name: open.space.name }))} />
  else if (open?.kind === 'settle') dialog = <SettleDialog closed={open.closed} action={open.action} users={users.filter((u) => u.id !== open.closed.userId)} groups={groups} onClose={close} onDone={() => finished(t('spacesAdmin.settleDone', { user: open.closed.username }))} />

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="alerts-page settings-page users-page spaces-page">
        <h1>{t('spacesAdmin.title')}</h1>
        <p className="alerts-intro">{t('spacesAdmin.intro')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        {done && <p className="alerts-done" role="status">{done}</p>}

        <section className="settings-section users-section" aria-labelledby="spaces-list">
          <h2 id="spaces-list">{t('spacesAdmin.directory')}</h2>
          {spaces === null ? <p className="hint">{t('common.loading')}</p> : sorted.length === 0 ? <p className="hint">{t('spacesAdmin.none')}</p> : (
            <div className="users-table-wrap">
              <table className="users-table">
                <thead>
                  <tr>
                    <th scope="col">{t('spacesAdmin.colName')}</th>
                    <th scope="col">{t('spacesAdmin.colManagers')}</th>
                    <th scope="col">{t('spacesAdmin.colMembers')}</th>
                    <th scope="col"><span className="visually-hidden">{t('users.colActions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((s) => {
                    const mine = s.managers.includes(me.username)
                    return (
                      <tr key={s.path}>
                        <th scope="row" className="user-name">
                          {s.name}
                          {s.aiClosed && <span className="lock-badge lock-badge-ai" role="img" aria-label={t('perm.lockAi')} title={t('perm.lockAi')}>{Icon.eyeOff}</span>}
                        </th>
                        <td>{s.managers.length ? s.managers.join(', ') : <span className="user-status user-status-disabled">{t(s.members === 0 ? 'spacesAdmin.noMembers' : 'spacesAdmin.noManagers')}</span>}</td>
                        <td>{s.members}</td>
                        <td className="user-actions space-admin-actions">
                          {s.managers.length === 0 && <Button className="btn" onPress={() => setOpen({ kind: 'manager', space: s })}>{t('spacesAdmin.assign')}</Button>}
                          {!mine && <Button className="btn" onPress={() => setOpen({ kind: 'join', space: s })}>{t('spacesAdmin.join')}</Button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">{t('spacesAdmin.directoryHint')}</p>
        </section>

        {closed.length > 0 && (
          <section className="settings-section" aria-labelledby="spaces-closed">
            <h2 id="spaces-closed">{t('spacesAdmin.closed')}</h2>
            <p className="hint">{t('spacesAdmin.closedIntro')}</p>
            <ul className="keys">
              {closed.map((c) => (
                <li key={c.userId} className="group-card">
                  <div className="key-head">
                    <h3 className="group-name">{t('spacesAdmin.closedOf', { user: c.username })}</h3>
                  </div>
                  <div className="key-actions">
                    <Button className="btn" onPress={() => setOpen({ kind: 'settle', closed: c, action: 'transfer' })}>{t('spacesAdmin.transfer')}</Button>
                    <Button className="btn" onPress={() => setOpen({ kind: 'settle', closed: c, action: 'convert' })}>{t('spacesAdmin.convert')}</Button>
                    <Button className="btn btn-danger" onPress={() => setOpen({ kind: 'settle', closed: c, action: 'delete' })}>{t('spacesAdmin.delete')}</Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(outside || strays) && (
          <section className="settings-section" aria-labelledby="spaces-outside">
            <h2 id="spaces-outside">{t('spacesAdmin.outside')}</h2>
            {outside && <p className="hint">{t('alerts.outsideSpacesBody')}</p>}
            {outside && <ul className="alert-paths">{outside.paths.map((p) => <li key={p}><span className="mono">{p}</span></li>)}</ul>}
            {strays && <p className="hint">{t('alerts.personFolderBody')}</p>}
            {strays && <ul className="alert-paths">{strays.names.map((n) => <li key={n}><span className="mono">people/{n}</span></li>)}</ul>}
          </section>
        )}

        <section className="settings-section" aria-labelledby="spaces-settings">
          <h2 id="spaces-settings">{t('spacesAdmin.creation')}</h2>
          {settings === null ? <p className="hint">{t('common.loading')}</p> : (
            <fieldset className="key-fieldset">
              <legend className="visually-hidden">{t('spacesAdmin.creation')}</legend>
              {(['everyone', 'admins'] as const).map((v) => (
                <label key={v} className="check">
                  <input type="radio" name="spacesCreation" checked={settings.spacesCreation === v} disabled={busy} onChange={() => void setCreation(v)} />
                  <span className="check-text">{t(v === 'everyone' ? 'spacesAdmin.creationEveryone' : 'spacesAdmin.creationAdmins')}<span className="hint">{t(v === 'everyone' ? 'spacesAdmin.creationEveryoneHint' : 'spacesAdmin.creationAdminsHint')}</span></span>
                </label>
              ))}
            </fieldset>
          )}
        </section>
      </div>
      <ModalOverlay className="modal-overlay" isOpen={open !== null} isDismissable onOpenChange={(o) => { if (!o) close() }}>
        <Modal className="modal">{dialog}</Modal>
      </ModalOverlay>
    </>
  )
}
