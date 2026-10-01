// Settings → «Agents and API» (D-035): the vihko admin's switches for the API
// with keys and the MCP server (locked when the server's administrator sets
// VIHKO_INTEGRATIONS=off) and whether members may create keys (off by
// default, D-049); everyone's own
// keys, created read-only and for every folder unless they say otherwise, the
// key shown once with ready-made MCP configurations, and rotated (a new
// secret, the old one still valid for 10 minutes); and, for the admin,
// everyone else's keys, which they may revoke. With a public URL
// (VIHKO_PUBLIC_URL), OAuth: where remote clients connect, the admin's switch
// for their registration (off by default, right under the MCP server's), and each authorization among the keys (named after
// its client, with where it goes back to). And, in plain words, what an agent
// knows of a note hidden from it.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, Heading, Input, Label, Modal, ModalOverlay, Switch, Tab, TabList, TabPanel, Tabs, Text, TextField } from 'react-aria-components'
import { keyWidens } from '@vihko/core/keyScope'
import { ApiError, api, type Integrations, type KeyInfo, type KeyWithUser, type User } from './api.ts'
import { copyText } from './copy.ts'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { useDates } from './history/ui.tsx'
import { AccessDialog } from './Permissions.tsx'
import { SearchButton } from './Palette.tsx'
import { ConfirmField, codeError, useConfirmWith } from './TwoFactor.tsx'
import { Diamond, Icon, MenuButton, ThemeToggle } from './ui.tsx'
import { usePathLabels } from './spaces.tsx'
import './actions.css'
import './agents.css'

type Translate = ReturnType<typeof useT>

/** Expiry presets, in days; `none`: it never expires. */
const PRESETS = ['none', '7', '30', '90', '365'] as const
type Preset = (typeof PRESETS)[number] | 'keep'
const presetKey: Record<Exclude<Preset, 'keep'>, MessageKey> = {
  none: 'keys.expiryNone', 7: 'keys.expiry7', 30: 'keys.expiry30', 90: 'keys.expiry90', 365: 'keys.expiry365',
}
const expiryFrom = (preset: Exclude<Preset, 'keep'>, now = Date.now()) => (preset === 'none' ? null : new Date(now + Number(preset) * 86_400_000).toISOString())

const viaLabel = (t: Translate, via: KeyInfo['lastVia']) => (via === 'mcp' ? t('keys.viaMcp') : via === 'oauth' ? t('keys.viaOauth') : t('keys.viaApi'))

/**
 * Every folder in the notes, those that only hold notes too, in tree order.
 * In NFC, as keys store them (a disk may hold NFD).
 */
export function allFolders(notes: { path: string }[], folders: string[]): string[] {
  const set = new Set<string>()
  const add = (raw: string) => {
    const f = raw.normalize('NFC')
    for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) set.add(f.slice(0, i))
    set.add(f)
  }
  for (const f of folders) if (f) add(f)
  for (const n of notes) if (n.path.includes('/')) add(n.path.slice(0, n.path.lastIndexOf('/')))
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  // Compared part by part: «a/b» goes right after «a», before «a b».
  return [...set].sort((a, b) => {
    const pa = a.split('/'), pb = b.split('/')
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const c = collator.compare(pa[i]!, pb[i]!)
      if (c) return c
    }
    return pa.length - pb.length
  })
}

/** A key's folder as the person sees it (D-056): its space and the folders inside. */
function FolderName({ path }: { path: string }) {
  const labels = usePathLabels()
  return <span className="mono">{labels.label(path)} /</span>
}

const within = (folder: string, chosen: readonly string[]) => chosen.some((c) => folder !== c && folder.startsWith(c + '/'))

/** The folders a key reaches, chosen from the tree: every folder, or only some (with what's inside them). */
export function FolderPicker({ all, chosen, onChange }: { all: string[] | null; chosen: string[]; onChange: (f: string[]) => void }) {
  const t = useT()
  const labels = usePathLabels()
  const [filter, setFilter] = useState('')
  if (all === null) return <p className="hint">{t('common.loading')}</p>
  if (all.length === 0) return <p className="hint">{t('keys.noFolders')}</p>
  const q = filter.trim().toLowerCase()
  // From each space's root down (D-056): `people` and `spaces` themselves are nobody's.
  const inSpaces = all.filter((f) => f.split('/').length >= 2)
  const shown = q ? inSpaces.filter((f) => labels.label(f).toLowerCase().includes(q)) : inSpaces
  const toggle = (f: string, on: boolean) => onChange(on ? [...chosen.filter((c) => !c.startsWith(f + '/')), f] : chosen.filter((c) => c !== f))
  return (
    <div className="folder-pick">
      {all.length > 8 && (
        <TextField className="field folder-filter" value={filter} onChange={setFilter} aria-label={t('keys.folderFilter')}>
          <Input placeholder={t('keys.folderFilter')} />
        </TextField>
      )}
      <ul className="folder-list" aria-label={t('keys.folders')}>
        {shown.map((f) => {
          const inherited = within(f, chosen)
          const depth = q ? 0 : f.split('/').length - 2
          return (
            <li key={f} style={{ paddingLeft: `calc(${depth} * var(--space-4))` }}>
              <label className="check">
                <input type="checkbox" checked={inherited || chosen.includes(f)} disabled={inherited} onChange={(e) => toggle(f, e.target.checked)} />
                <span className="check-text">{q ? labels.label(f) : depth === 0 ? labels.space(f) : f.slice(f.lastIndexOf('/') + 1)}</span>
              </label>
            </li>
          )
        })}
        {shown.length === 0 && <li className="hint">{t('keys.folderNone')}</li>}
      </ul>
    </div>
  )
}

/** Create a key, or change one of yours: name, whether it may write, its folders and when it expires. */
function KeyDialog({ edit, onClose, onCreated, onSaved }: {
  edit: KeyInfo | null
  onClose: () => void
  onCreated: (key: KeyInfo, token: string) => void
  onSaved: (key: KeyInfo) => void
}) {
  const t = useT()
  const dates = useDates()
  const [name, setName] = useState(edit?.name ?? '')
  const [canWrite, setCanWrite] = useState(edit?.canWrite ?? false)
  const [some, setSome] = useState((edit?.folders.length ?? 0) > 0)
  const [folders, setFolders] = useState<string[]>(edit?.folders ?? [])
  const [preset, setPreset] = useState<Preset>(edit ? 'keep' : 'none')
  const [all, setAll] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A new key, or a change that lets one do more, is confirmed at the moment (D-036, D-046.2): the current code, or the password.
  const confirmWith = useConfirmWith()
  const [confirm, setConfirm] = useState('')

  useEffect(() => {
    let live = true
    // A key's folder that is no longer there is still listed: it can be unchecked.
    const own = edit?.folders ?? []
    api.tree().then((r) => { if (live) setAll(allFolders(r.notes, [...r.folders, ...own])) }, () => { if (live) setAll(allFolders([], own)) })
    return () => { live = false }
  }, [])

  const noneChosen = some && folders.length === 0
  const input = () => ({ name: name.trim(), canWrite, folders: some ? folders : [], ...(preset === 'keep' ? {} : { expiresAt: expiryFrom(preset) }) })
  // A change that lets the key do more is confirmed as a new key is (D-046.2); narrowing or renaming it, not.
  const asks = !edit || keyWidens(edit, input())
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !name.trim() || noneChosen || (asks && !confirm.trim())) return
    setBusy(true)
    setError(null)
    try {
      if (edit) onSaved(await api.updateKey(edit.id, { ...input(), ...(asks ? { confirm: confirm.trim() } : {}) }))
      else {
        const r = await api.createKey({ ...input(), confirm: confirm.trim() })
        onCreated(r.key, r.token)
      }
    } catch (err) {
      setError(codeError(t, err))
      setBusy(false)
    }
  }

  const keepLabel = edit?.expiresAt ? t('keys.expiryKeep', { date: dates.dateTime(edit.expiresAt) }) : t('keys.expiryKeepNone')
  return (
    <Dialog className="dialog key-dialog">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{edit ? t('keys.editTitle', { name: edit.name }) : t('keys.newTitle')}</Heading>
          <TextField className="field" value={name} onChange={setName} maxLength={100} isRequired autoFocus>
            <Label>{t('keys.name')}</Label>
            <Input />
            <Text slot="description" className="hint">{t('keys.nameHint')}</Text>
          </TextField>
          <label className="check">
            <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} />
            <span className="check-text">
              {t('keys.canWrite')}
              <span className="hint">{t('keys.canWriteHint')}</span>
            </span>
          </label>
          <fieldset className="key-fieldset">
            <legend>{t('keys.folders')}</legend>
            <label className="check">
              <input type="radio" name="scope" checked={!some} onChange={() => setSome(false)} />
              <span className="check-text">{t('keys.foldersAll')}</span>
            </label>
            <label className="check">
              <input type="radio" name="scope" checked={some} onChange={() => setSome(true)} />
              <span className="check-text">{t('keys.foldersSome')}</span>
            </label>
            {some && <FolderPicker all={all} chosen={folders} onChange={setFolders} />}
            <span className="hint">{t('keys.foldersHint')}</span>
          </fieldset>
          <label className="field">
            <span>{t('keys.expiry')}</span>
            <select className="select" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {edit && <option value="keep">{keepLabel}</option>}
              {PRESETS.map((p) => <option key={p} value={p}>{t(presetKey[p])}</option>)}
            </select>
          </label>
          {asks && <ConfirmField how={confirmWith} value={confirm} onChange={setConfirm} hint={t(edit ? 'keys.confirmWiderHint' : 'keys.confirmHint')} />}
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {noneChosen && <span className="hint key-need">{t('keys.foldersNeeded')}</span>}
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !name.trim() || noneChosen || (asks && !confirm.trim())}>{t(edit ? 'keys.save' : 'keys.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** A «Copy» button that says whether it worked (copy.ts: also on plain http). */
export function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 4000)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <span className="copy">
      <Button className={primary ? 'btn btn-primary' : 'btn'} onPress={async () => setState((await copyText(text)) ? 'copied' : 'failed')}>{label}</Button>
      <span className={state === 'failed' ? 'copy-state copy-failed' : 'copy-state'} role="status">
        {state === 'copied' ? t('keys.copied') : state === 'failed' ? t('keys.copyFailed') : ''}
      </span>
    </span>
  )
}

/** Where MCP clients reach this vihko. */
const mcpUrl = () => `${location.origin}/mcp`

/**
 * Ready-made configurations for the key: Claude Code, Claude Desktop
 * (through mcp-remote, which it needs for a server with a header; the key
 * goes in a file, `header`, whose path replaces `headerPath`, so it never
 * shows in the process list, as mcp-remote advises; on plain http it has to
 * be allowed), a generic `mcpServers` JSON and the HTTP API.
 */
export function mcpConfigs(token: string, origin = location.origin, headerPath = '/path/to/vihko-mcp.txt') {
  const url = `${origin}/mcp`
  const http = origin.startsWith('http:')
  const json = (v: unknown) => JSON.stringify(v, null, 2)
  return {
    code: `claude mcp add --transport http vihko ${url} --header "Authorization: Bearer ${token}"`,
    desktop: json({
      mcpServers: {
        vihko: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header-file', headerPath, ...(http ? ['--allow-http'] : [])],
        },
      },
    }),
    header: `Authorization: Bearer ${token}`,
    json: json({ mcpServers: { vihko: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }),
    api: `curl -H "Authorization: Bearer ${token}" ${origin}/api/tree`,
  }
}

type ConfigTab = 'code' | 'desktop' | 'json' | 'api'

/** The new key, shown this once: copy it, or copy it into an MCP configuration. After a rotation, until when the old one works. */
function TokenDialog({ keyInfo, token, integrations, onClose }: { keyInfo: KeyInfo; token: string; integrations: Integrations | null; onClose: () => void }) {
  const t = useT()
  const dates = useDates()
  const headerPath = t('keys.headerPath')
  const configs = useMemo(() => mcpConfigs(token, location.origin, headerPath), [token, headerPath])
  const [tab, setTab] = useState<ConfigTab>('code')
  const tabs: { id: ConfigTab; label: MessageKey; hint: MessageKey }[] = [
    { id: 'code', label: 'keys.cfgCode', hint: 'keys.cfgCodeHint' },
    { id: 'desktop', label: 'keys.cfgDesktop', hint: 'keys.cfgDesktopHint' },
    { id: 'json', label: 'keys.cfgJson', hint: 'keys.cfgJsonHint' },
    { id: 'api', label: 'keys.cfgApi', hint: 'keys.cfgApiHint' },
  ]
  // Whatever the key's use, say if it won't work yet.
  const off = !integrations ? null
    : integrations.locked ? t('keys.cfgLocked')
      : !integrations.api || !integrations.mcp ? t('keys.cfgOff', { what: [!integrations.api && 'API', !integrations.mcp && 'MCP'].filter(Boolean).join(' · ') })
        : null
  return (
    <Dialog className="dialog key-dialog" aria-label={t('keys.tokenTitle', { name: keyInfo.name })}>
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t('keys.tokenTitle', { name: keyInfo.name })}</Heading>
        <p className="key-once" role="note">{Icon.alert}<span>{t('keys.tokenOnce')}</span></p>
        {keyInfo.previousUntil && <p className="hint">{t('keys.rotatedOld', { time: dates.time(keyInfo.previousUntil) })}</p>}
        <div className="token-row">
          <code className="token" aria-label={t('keys.tokenLabel')} tabIndex={0}>{token}</code>
          <CopyButton text={token} label={t('keys.copy')} primary />
        </div>
        <div className="mcp-configs">
          <h3 className="key-subtitle">{t('keys.cfgTitle')}</h3>
          {off && <p className="hint">{off}</p>}
          <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as ConfigTab)}>
            <TabList className="cfg-tabs" aria-label={t('keys.cfgTitle')}>
              {tabs.map((x) => <Tab key={x.id} id={x.id} className="cfg-tab">{t(x.label)}</Tab>)}
            </TabList>
            {tabs.map((x) => (
              <TabPanel key={x.id} id={x.id} className="cfg-panel">
                <p className="hint">{t(x.hint, { url: mcpUrl(), path: headerPath })}</p>
                {x.id === 'desktop' && (<>
                  <pre className="cfg-block cfg-header" tabIndex={0} aria-label={t('keys.headerLabel')}>{configs.header}</pre>
                  <CopyButton text={configs.header} label={t('keys.copyHeader')} />
                </>)}
                <pre className="cfg-block" tabIndex={0}>{configs[x.id]}</pre>
              </TabPanel>
            ))}
          </Tabs>
          <CopyButton text={configs[tab]} label={t(tab === 'api' ? 'keys.copyApi' : 'keys.copyMcp')} />
        </div>
      </div>
      <div className="dialog-actions">
        <Button className="btn btn-primary" onPress={onClose}>{t('keys.tokenDone')}</Button>
      </div>
    </Dialog>
  )
}

/** Revoking is for good: asked first, saying whose key it is if it isn't yours. */
function RevokeDialog({ keyInfo, owner, onClose, onRevoked }: { keyInfo: KeyInfo; owner: string | null; onClose: () => void; onRevoked: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.revokeKey(keyInfo.id)
      onRevoked()
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t('keys.revokeTitle', { name: keyInfo.name })}</Heading>
        {owner && <p className="dialog-text">{t('keys.revokeOwner', { user: owner })}</p>}
        <p className="dialog-text">{t(keyInfo.client ? 'keys.revokeOauthBody' : 'keys.revokeBody')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('common.cancel')}</Button>
        <Button className="btn btn-danger" onPress={() => void revoke()} isDisabled={busy}>{t(keyInfo.client ? 'keys.revokeConfirmOauth' : 'keys.revokeConfirm')}</Button>
      </div>
    </Dialog>
  )
}

/** Rotating: asked first, and confirmed as a new key is; then the new key, shown once (TokenDialog). */
function RotateDialog({ keyInfo, onClose, onRotated }: { keyInfo: KeyInfo; onClose: () => void; onRotated: (key: KeyInfo, token: string) => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmWith = useConfirmWith()
  const [confirm, setConfirm] = useState('')
  const rotate = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !confirm.trim()) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.rotateKey(keyInfo.id, confirm.trim())
      onRotated(r.key, r.token)
    } catch (err) {
      setError(codeError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow" role="alertdialog">
      <form onSubmit={rotate}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('keys.rotateTitle', { name: keyInfo.name })}</Heading>
          <p className="dialog-text">{t('keys.rotateBody')}</p>
          <p className="dialog-text">{t('keys.rotateGrace')}</p>
          <ConfirmField how={confirmWith} value={confirm} onChange={setConfirm} hint={t('keys.confirmHint')} />
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !confirm.trim()}>{t('keys.rotateConfirm')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** One key: what it may do and where, when it expires, when and how it was last used. */
function KeyCard({ k, owner, actions }: { k: KeyInfo; owner?: string; actions: ReactNode }) {
  const t = useT()
  const dates = useDates()
  const row = (label: MessageKey, value: ReactNode) => <div className="key-row"><dt>{t(label)}</dt><dd>{value}</dd></div>
  const expiry = !k.expiresAt ? t('keys.expiresNever') : t(k.status === 'expired' ? 'keys.expired' : 'keys.expires', { date: dates.dateTime(k.expiresAt) })
  // Someone else's key may reach folders of their spaces the admin doesn't read: never named (D-056).
  const hiddenFolders = 'foldersHidden' in k && k.foldersHidden === true
  return (
    <li className={`key-card key-card-${k.status}`}>
      <div className="key-head">
        <Diamond />
        <h3 className="key-name">{k.name}</h3>
        {owner && <span className="key-owner">{t('keys.of', { user: owner })}</span>}
        {k.client && <span className="key-badge" title={t('keys.oauthBadgeHint')}>{t('keys.oauthBadge')}</span>}
        <span className={`key-status key-status-${k.status}`}>{t(k.status === 'active' ? 'keys.active' : k.status === 'expired' ? 'keys.statusExpired' : 'keys.revoked')}</span>
      </div>
      <dl className="key-meta">
        {row('keys.permissions', t(k.canWrite ? 'keys.readWrite' : 'keys.readOnly'))}
        {row('keys.folders', k.folders.length === 0 && !hiddenFolders ? t('keys.foldersAllShort') : (
          <span className="key-folders">
            {k.folders.map((f) => <FolderName key={f} path={f} />)}
            {hiddenFolders && <span>{t(k.folders.length ? 'keys.foldersHiddenMore' : 'keys.foldersHidden')}</span>}
          </span>
        ))}
        {row('keys.expiry', expiry)}
        {row('keys.lastUsed', k.lastUsedAt ? t('keys.lastUsedAt', { date: dates.dateTime(k.lastUsedAt), via: viaLabel(t, k.lastVia) }) : t('keys.neverUsed'))}
        {k.revokedAt && row('keys.revokedAt', dates.dateTime(k.revokedAt))}
        {k.client
          ? row('keys.returnsTo', <span className="key-folders">{k.client.redirectUris.map((u) => <span key={u} className="mono">{u}</span>)}</span>)
          : row('keys.key', <span className="mono">vihko_…{k.last4}</span>)}
        {k.previousUntil && row('keys.previous', t('keys.previousUntil', { time: dates.time(k.previousUntil) }))}
      </dl>
      {actions && <div className="key-actions">{actions}</div>}
    </li>
  )
}

/** A switch that saves at once; locked ones say why. */
export function Toggle({ label, hint, value, disabled, onChange }: { label: string; hint: string; value: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch className="switch" isSelected={value} isDisabled={disabled} onChange={onChange}>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      <span className="check-text">{label}<span className="hint">{hint}</span></span>
    </Switch>
  )
}

type Open =
  | { kind: 'new' }
  | { kind: 'edit'; key: KeyInfo }
  | { kind: 'token'; key: KeyInfo; token: string }
  | { kind: 'revoke'; key: KeyInfo; owner: string | null }
  | { kind: 'rotate'; key: KeyInfo }
  | { kind: 'access'; key: KeyInfo }

export function AgentsPage({ user, onUnauthorized, onPrivacy }: { user: User; onUnauthorized: () => void; onPrivacy: () => void }) {
  const t = useT()
  const admin = user.role === 'admin'
  const [integ, setInteg] = useState<Integrations | null>(null)
  const [mine, setMine] = useState<KeyInfo[] | null>(null)
  const [others, setOthers] = useState<KeyWithUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<Open | null>(null)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }
  const load = () => Promise.all([
    api.integrations().then(setInteg),
    api.keys().then(setMine),
    admin ? api.allKeys().then((all) => setOthers(all.filter((k) => k.userId !== user.id))) : null,
  ]).catch(fail)
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const change = async (patch: Parameters<typeof api.setIntegrations>[0]) => {
    setSaving(true)
    setError(null)
    try { setInteg(await api.setIntegrations(patch)) } catch (err) { fail(err); void load() }
    setSaving(false)
  }
  const close = () => setOpen(null)
  const done = () => { close(); void load() }

  const canCreate = integ?.canCreateKeys ?? false
  const live = <K extends KeyInfo>(list: K[] | null) => (list ?? []).filter((k) => k.status !== 'revoked')
  const gone = <K extends KeyInfo>(list: K[] | null) => (list ?? []).filter((k) => k.status === 'revoked')
  const own = (k: KeyInfo) => (
    <KeyCard key={k.id} k={k} actions={k.status === 'revoked' ? null : (<>
      {k.status === 'active' && <Button className="btn" onPress={() => setOpen({ kind: 'access', key: k })}>{t('perm.keyAccessAction')}</Button>}
      {canCreate && k.status === 'active' && <Button className="btn" onPress={() => setOpen({ kind: 'edit', key: k })}>{t('keys.edit')}</Button>}
      {/* An OAuth authorization has no key to rotate: it is revoked, and authorized again. */}
      {canCreate && k.status === 'active' && !k.client && <Button className="btn" onPress={() => setOpen({ kind: 'rotate', key: k })}>{t('keys.rotate')}</Button>}
      <Button className="btn btn-danger" onPress={() => setOpen({ kind: 'revoke', key: k, owner: null })}>{t('keys.revoke')}</Button>
    </>)} />
  )
  const theirs = (k: KeyWithUser) => (
    <KeyCard key={k.id} k={k} owner={k.user.username} actions={k.status === 'revoked' ? null : (<>
      {k.status === 'active' && <Button className="btn" onPress={() => setOpen({ kind: 'access', key: k })}>{t('perm.keyAccessAction')}</Button>}
      <Button className="btn btn-danger" onPress={() => setOpen({ kind: 'revoke', key: k, owner: k.user.username })}>{t('keys.revoke')}</Button>
    </>)} />
  )
  const revoked = <K extends KeyInfo>(list: K[], render: (k: K) => ReactNode) => list.length > 0 && (
    <details className="keys-revoked">
      <summary>{t('keys.revokedList', { n: list.length })}</summary>
      <ul className="keys">{list.map(render)}</ul>
    </details>
  )

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="alerts-page settings-page">
        <h1>{t('agents.title')}</h1>
        <p className="alerts-intro">
          {t('agents.intro')}{' '}
          <a href="?view=privacy" onClick={(e) => { e.preventDefault(); onPrivacy() }}>{t('agents.privacyLink')}</a>
        </p>
        {error && <p className="error-text" role="alert">{error}</p>}

        <section className="settings-section" aria-labelledby="agents-switches">
          <h2 id="agents-switches">{t('agents.switches')}</h2>
          {integ === null ? <p className="hint">{t('common.loading')}</p> : (<>
            {integ.locked && <p className="key-locked" role="note">{Icon.alert}<span>{t('agents.locked')}</span></p>}
            {admin ? (
              <div className="switches">
                <Toggle label={t('agents.api')} hint={t('agents.apiHint')} value={integ.api && !integ.locked} disabled={integ.locked || saving} onChange={(v) => void change({ api: v })} />
                <Toggle label={t('agents.mcp')} hint={t('agents.mcpHint', { url: mcpUrl() })} value={integ.mcp && !integ.locked} disabled={integ.locked || saving} onChange={(v) => void change({ mcp: v })} />
                {/* Under the MCP server: registration is part of connecting remote MCP clients. */}
                {integ.publicUrl && (
                  <Toggle label={t('agents.oauthRegistration')} hint={t('agents.oauthRegistrationHint')} value={integ.oauthRegistration} disabled={saving} onChange={(v) => void change({ oauthRegistration: v })} />
                )}
                <Toggle label={t('agents.members')} hint={t('agents.membersHint')} value={integ.membersCanCreateKeys} disabled={saving} onChange={(v) => void change({ membersCanCreateKeys: v })} />
              </div>
            ) : (
              <p className="settings-state">
                {t(integ.api && !integ.locked ? 'agents.apiOn' : 'agents.apiOff')} {t(integ.mcp && !integ.locked ? 'agents.mcpOn' : 'agents.mcpOff')}
                <span className="hint">{t('agents.stateHint')}</span>
              </p>
            )}
          </>)}
        </section>

        {integ && (integ.publicUrl || admin) && (
          <section className="settings-section" aria-labelledby="agents-oauth">
            <h2 id="agents-oauth">{t('agents.oauthTitle')}</h2>
            {integ.publicUrl ? (<>
              <p className="hint">{t('agents.oauthBody')}</p>
              <div className="token-row">
                <code className="token" aria-label={t('agents.oauthUrl')} tabIndex={0}>{`${integ.publicUrl}/mcp`}</code>
                <CopyButton text={`${integ.publicUrl}/mcp`} label={t('keys.copy')} />
              </div>
              {(integ.locked || !integ.mcp) && <p className="hint">{t('agents.oauthNeedsMcp')}</p>}
              {!integ.oauthRegistration && <p className="hint">{t('agents.oauthNeedsRegistration')}</p>}
            </>) : <p className="hint">{t('agents.oauthNone')}</p>}
          </section>
        )}

        <section className="settings-section" aria-labelledby="agents-mine">
          <div className="settings-head">
            <h2 id="agents-mine">{t('keys.mine')}</h2>
            <span className="spacer" />
            {canCreate && <Button className="btn btn-primary" onPress={() => setOpen({ kind: 'new' })}>{Icon.plus}{t('keys.new')}</Button>}
          </div>
          {integ && !canCreate && <p className="hint">{t('keys.membersOff')}</p>}
          {mine === null ? <p className="hint">{t('common.loading')}</p>
            : live(mine).length === 0 ? <p className="hint">{t('keys.none')}</p>
              : <ul className="keys">{live(mine).map(own)}</ul>}
          {revoked(gone(mine), own)}
        </section>

        {admin && (
          <section className="settings-section" aria-labelledby="agents-others">
            <h2 id="agents-others">{t('keys.others')}</h2>
            {others === null ? <p className="hint">{t('common.loading')}</p>
              : live(others).length === 0 ? <p className="hint">{t('keys.othersNone')}</p>
                : <ul className="keys">{live(others).map(theirs)}</ul>}
            {revoked(gone(others), theirs)}
          </section>
        )}

        <section className="settings-section" aria-labelledby="agents-hidden">
          <h2 id="agents-hidden">{t('agents.hiddenTitle')}</h2>
          <p className="hint">{t('agents.hiddenBody')}</p>
        </section>
      </div>
      <ModalOverlay className="modal-overlay" isOpen={open !== null} isDismissable={open?.kind !== 'token'} isKeyboardDismissDisabled={open?.kind === 'token'}
        onOpenChange={(o) => { if (!o) close() }}>
        <Modal className="modal">
          {(open?.kind === 'new' || open?.kind === 'edit') && (
            <KeyDialog edit={open.kind === 'edit' ? open.key : null} onClose={close}
              onCreated={(key, token) => { setOpen({ kind: 'token', key, token }); void load() }}
              onSaved={done} />
          )}
          {open?.kind === 'token' && <TokenDialog keyInfo={open.key} token={open.token} integrations={integ} onClose={close} />}
          {open?.kind === 'revoke' && <RevokeDialog keyInfo={open.key} owner={open.owner} onClose={close} onRevoked={done} />}
          {open?.kind === 'access' && <AccessDialog who={{ key: open.key.id }} title={t('perm.keyAccessTitle', { name: open.key.name })} onClose={close} onUnauthorized={onUnauthorized} />}
          {open?.kind === 'rotate' &&<RotateDialog keyInfo={open.key} onClose={close} onRotated={(key, token) => { setOpen({ kind: 'token', key, token }); void load() }} />}
        </Modal>
      </ModalOverlay>
    </>
  )
}
