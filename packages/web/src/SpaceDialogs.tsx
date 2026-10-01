// Dialogs of the spaces (D-056, spec §5.2): a new shared space (its name and,
// if wanted, its first members; whoever creates it manages it), renaming one,
// leaving a space or a folder shared with one, and deleting a space (what it
// holds goes to the trash, which its managers can restore).
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, Dialog, Heading, Input, Label, Text, TextField } from 'react-aria-components'
import { ApiError, LEVELS, api, type Grants, type Level, type SpaceEntry } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { LEVEL_LABEL } from './Permissions.tsx'
import { Icon, NAME_INPUT } from './ui.tsx'
import './actions.css'
import './permissions.css'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** The name of a space as people type it: NFC, no spaces around. */
const cleanName = (name: string) => name.normalize('NFC').trim()

/** Members to add: people and groups of the directory, each with a level. */
function MembersPicker({ members, onChange, exclude }: { members: Grants; onChange: (m: Grants) => void; exclude: string }) {
  const t = useT()
  const [directory, setDirectory] = useState<{ users: string[]; groups: string[] } | null>(null)
  const [who, setWho] = useState('')
  const [level, setLevel] = useState<Level>('edit')
  useEffect(() => { api.directory().then(setDirectory).catch(() => setDirectory({ users: [], groups: [] })) }, [])
  const taken = new Set([...Object.keys(members), exclude].map((s) => s.toLowerCase()))
  const users = (directory?.users ?? []).filter((u) => !taken.has(u.toLowerCase())).sort(collator.compare)
  const groups = (directory?.groups ?? []).filter((g) => !taken.has(`@${g}`.toLowerCase())).sort(collator.compare)
  const rows = Object.keys(members).sort(collator.compare)
  return (
    <div className="space-members">
      {rows.length > 0 && (
        <ul className="perm-rows" aria-label={t('spaces.membersList')}>
          {rows.map((s) => (
            <li key={s} className="perm-row">
              <span className="perm-subject">
                <span className={`perm-avatar${s.startsWith('@') ? ' perm-avatar-group' : ''}`} aria-hidden="true">{s.startsWith('@') ? Icon.people : s.slice(0, 1).toUpperCase()}</span>
                <span className="perm-name">{s}</span>
              </span>
              <select className="select perm-level" aria-label={t('perm.levelOf', { who: s })} value={members[s]} onChange={(e) => onChange({ ...members, [s]: e.target.value as Level })}>
                {LEVELS.map((l) => <option key={l} value={l}>{t(LEVEL_LABEL[l])}</option>)}
              </select>
              <Button className="btn btn-icon btn-quiet perm-remove" aria-label={t('perm.remove', { who: s })} onPress={() => { const next = { ...members }; delete next[s]; onChange(next) }}>{Icon.close}</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="perm-add">
        <select className="select perm-add-who" aria-label={t('perm.addWho')} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t('perm.addPick')}</option>
          {users.length > 0 && <optgroup label={t('perm.people')}>{users.map((u) => <option key={u} value={u}>{u}</option>)}</optgroup>}
          {groups.length > 0 && <optgroup label={t('perm.groups')}>{groups.map((g) => <option key={g} value={`@${g}`}>@{g}</option>)}</optgroup>}
        </select>
        <select className="select perm-level" aria-label={t('perm.addLevel')} value={level} onChange={(e) => setLevel(e.target.value as Level)}>
          {LEVELS.map((l) => <option key={l} value={l}>{t(LEVEL_LABEL[l])}</option>)}
        </select>
        <Button className="btn" isDisabled={!who} onPress={() => { onChange({ ...members, [who]: level }); setWho('') }}>{Icon.plus}{t('perm.add')}</Button>
      </div>
    </div>
  )
}

/** A new shared space: its name and its first members; whoever creates it manages it. */
export function NewSpaceDialog({ me, onClose, onCreated }: { me: string; onClose: () => void; onCreated: (space: SpaceEntry) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [members, setMembers] = useState<Grants>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !cleanName(name)) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.createSpace(cleanName(name), members))
    } catch (err) {
      setError(spaceError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('spaces.newTitle')}</Heading>
          <p className="dialog-text">{t('spaces.newBody')}</p>
          <TextField className="field" value={name} onChange={setName} maxLength={64} isRequired autoFocus>
            <Label>{t('spaces.name')}</Label>
            <Input autoComplete="off" />
            <Text slot="description" className="hint">{t('spaces.nameHint')}</Text>
          </TextField>
          <fieldset className="key-fieldset">
            <legend>{t('spaces.firstMembers')}</legend>
            <MembersPicker members={members} onChange={setMembers} exclude={me} />
            <p className="hint">{t('spaces.youManage')}</p>
          </fieldset>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !cleanName(name)}>{t('spaces.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Renames a shared space: its folder (and its notes' addresses) take the new name; links between its notes stay as they are. */
export function RenameSpaceDialog({ path, name: current, onClose, onRenamed }: { path: string; name: string; onClose: () => void; onRenamed: (space: SpaceEntry) => void }) {
  const t = useT()
  const [name, setName] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !cleanName(name) || cleanName(name) === current) return
    setBusy(true)
    setError(null)
    try {
      onRenamed(await api.renameSpace(path, cleanName(name)))
    } catch (err) {
      setError(spaceError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('spaces.renameTitle', { name: current })}</Heading>
          <TextField className="field" value={name} onChange={setName} maxLength={64} isRequired autoFocus>
            <Label>{t('spaces.name')}</Label>
            <Input autoComplete="off" {...NAME_INPUT} autoCapitalize="sentences" />
            <Text slot="description" className="hint">{t('spaces.renameHint')}</Text>
          </TextField>
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !cleanName(name) || cleanName(name) === current}>{t('spaces.renameConfirm')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** The text of an error about spaces: leaving through a group names the group. */
export function spaceError(t: ReturnType<typeof useT>, err: unknown): string {
  if (err instanceof ApiError && err.code === 'leave_via_group' && typeof err.data?.group === 'string') return t('spaces.viaGroup', { group: `@${err.data.group}` })
  if (err instanceof ApiError && err.code === 'space_name_taken' && typeof err.data?.name === 'string') return t('spaces.nameTaken', { name: err.data.name })
  if (err instanceof ApiError && err.code === 'invalid' && typeof err.data?.problem === 'string') {
    const p = err.data.problem
    return t(p === 'invalid_characters' ? 'spaces.nameSlash' : p === 'invalid_name' ? 'spaces.nameReserved' : 'spaces.nameInvalid')
  }
  return errorText(t, err)
}

/**
 * Leaving a space, or no longer seeing a folder shared with one: nothing is
 * deleted, and whoever shares it can add them again.
 */
export function LeaveSpaceDialog({ path, name, kind, onClose, onLeft }: { path: string; name: string; kind: 'shared' | 'received'; onClose: () => void; onLeft: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.leaveSpace(path)
      onLeft()
    } catch (err) {
      setError(spaceError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t(kind === 'shared' ? 'spaces.leaveTitle' : 'spaces.stopTitle', { name })}</Heading>
        <p className="dialog-text">{t(kind === 'shared' ? 'spaces.leaveBody' : 'spaces.stopBody')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('common.cancel')}</Button>
        <Button className="btn btn-danger" isDisabled={busy} onPress={() => void go()}>{t(kind === 'shared' ? 'spaces.leaveConfirm' : 'spaces.stopConfirm')}</Button>
      </div>
    </Dialog>
  )
}

/** Deleting a shared space: how many notes go to the trash, and who can bring them back (its managers). */
export function DeleteSpaceDialog({ space, notes, onClose, onDeleted }: { space: SpaceEntry; notes: number; onClose: () => void; onDeleted: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const managers = useMemo(() => [...space.managers].sort(collator.compare).join(', '), [space.managers])
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteSpace(space.path, true)
      onDeleted()
    } catch (err) {
      setError(spaceError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t('spaces.deleteTitle', { name: space.name })}</Heading>
        <ul className="consequences">
          <li>{notes === 0 ? t('spaces.deleteEmpty') : t(notes === 1 ? 'spaces.deleteNotesOne' : 'spaces.deleteNotes', { n: notes })}</li>
          {notes > 0 && <li>{t('spaces.deleteRestore', { managers })}</li>}
          <li>{t('spaces.deleteMembers')}</li>
        </ul>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('common.cancel')}</Button>
        <Button className="btn btn-danger" isDisabled={busy} onPress={() => void go()}>{t('spaces.deleteConfirm')}</Button>
      </div>
    </Dialog>
  )
}
