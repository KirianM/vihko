// Settings → «Agents and API» (D-035): the thoth admin's switches for the API
// with keys and the MCP server (locked when the server's administrator sets
// THOTH_INTEGRATIONS=off) and whether members may create keys; everyone's own
// keys, created read-only and for every folder unless they say otherwise, the
// key shown once with ready-made MCP configurations; and, for the admin,
// everyone else's keys, which they may revoke.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, Heading, Input, Label, Modal, ModalOverlay, Switch, Tab, TabList, TabPanel, Tabs, Text, TextField } from 'react-aria-components'
import { ApiError, api, type Integrations, type KeyInfo, type KeyWithUser, type User } from './api.ts'
import { copyText } from './copy.ts'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { useDates } from './history/ui.tsx'
import { SearchButton } from './Palette.tsx'
import { Diamond, Icon, MenuButton, ThemeToggle } from './ui.tsx'
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
function allFolders(notes: { path: string }[], folders: string[]): string[] {
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

const within = (folder: string, chosen: readonly string[]) => chosen.some((c) => folder !== c && folder.startsWith(c + '/'))

/** The folders a key reaches, chosen from the tree: every folder, or only some (with what's inside them). */
function FolderPicker({ all, chosen, onChange }: { all: string[] | null; chosen: string[]; onChange: (f: string[]) => void }) {
  const t = useT()
  const [filter, setFilter] = useState('')
  if (all === null) return <p className="hint">{t('common.loading')}</p>
  if (all.length === 0) return <p className="hint">{t('keys.noFolders')}</p>
  const q = filter.trim().toLowerCase()
  const shown = q ? all.filter((f) => f.toLowerCase().includes(q)) : all
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
          const depth = q ? 0 : f.split('/').length - 1
          return (
            <li key={f} style={{ paddingLeft: `calc(${depth} * var(--space-4))` }}>
              <label className="check">
                <input type="checkbox" checked={inherited || chosen.includes(f)} disabled={inherited} onChange={(e) => toggle(f, e.target.checked)} />
                <span className="check-text">{q ? f.split('/').join(' / ') : f.slice(f.lastIndexOf('/') + 1)}</span>
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

  useEffect(() => {
    let live = true
    // A key's folder that is no longer there is still listed: it can be unchecked.
    const own = edit?.folders ?? []
    api.tree().then((r) => { if (live) setAll(allFolders(r.notes, [...r.folders, ...own])) }, () => { if (live) setAll(allFolders([], own)) })
    return () => { live = false }
  }, [])

  const noneChosen = some && folders.length === 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !name.trim() || noneChosen) return
    setBusy(true)
    setError(null)
    const input = { name: name.trim(), canWrite, folders: some ? folders : [], ...(preset === 'keep' ? {} : { expiresAt: expiryFrom(preset) }) }
    try {
      if (edit) onSaved(await api.updateKey(edit.id, input))
      else {
        const r = await api.createKey(input)
        onCreated(r.key, r.token)
      }
    } catch (err) {
      setError(errorText(t, err))
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
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {noneChosen && <span className="hint key-need">{t('keys.foldersNeeded')}</span>}
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !name.trim() || noneChosen}>{t(edit ? 'keys.save' : 'keys.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** A «Copy» button that says whether it worked (copy.ts: also on plain http). */
function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
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

/** Where MCP clients reach this thoth. */
const mcpUrl = () => `${location.origin}/mcp`

/**
 * Ready-made configurations for the key: Claude Code, Claude Desktop
 * (through mcp-remote, which it needs for a server with a header; on plain
 * http it has to be allowed), a generic `mcpServers` JSON and the HTTP API.
 */
export function mcpConfigs(token: string, origin = location.origin) {
  const url = `${origin}/mcp`
  const http = origin.startsWith('http:')
  const json = (v: unknown) => JSON.stringify(v, null, 2)
  return {
    code: `claude mcp add --transport http thoth ${url} --header "Authorization: Bearer ${token}"`,
    desktop: json({
      mcpServers: {
        thoth: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${THOTH_AUTH}', ...(http ? ['--allow-http'] : [])],
          env: { THOTH_AUTH: `Bearer ${token}` },
        },
      },
    }),
    json: json({ mcpServers: { thoth: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }),
    api: `curl -H "Authorization: Bearer ${token}" ${origin}/api/tree`,
  }
}

type ConfigTab = 'code' | 'desktop' | 'json' | 'api'

/** The new key, shown this once: copy it, or copy it into an MCP configuration. */
function TokenDialog({ keyInfo, token, integrations, onClose }: { keyInfo: KeyInfo; token: string; integrations: Integrations | null; onClose: () => void }) {
  const t = useT()
  const configs = useMemo(() => mcpConfigs(token), [token])
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
                <p className="hint">{t(x.hint, { url: mcpUrl() })}</p>
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
        <p className="dialog-text">{t('keys.revokeBody')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <Button className="btn" onPress={onClose} autoFocus>{t('common.cancel')}</Button>
        <Button className="btn btn-danger" onPress={() => void revoke()} isDisabled={busy}>{t('keys.revokeConfirm')}</Button>
      </div>
    </Dialog>
  )
}

/** One key: what it may do and where, when it expires, when and how it was last used. */
function KeyCard({ k, owner, actions }: { k: KeyInfo; owner?: string; actions: ReactNode }) {
  const t = useT()
  const dates = useDates()
  const row = (label: MessageKey, value: ReactNode) => <div className="key-row"><dt>{t(label)}</dt><dd>{value}</dd></div>
  const expiry = !k.expiresAt ? t('keys.expiresNever') : t(k.status === 'expired' ? 'keys.expired' : 'keys.expires', { date: dates.dateTime(k.expiresAt) })
  return (
    <li className={`key-card key-card-${k.status}`}>
      <div className="key-head">
        <Diamond />
        <h3 className="key-name">{k.name}</h3>
        {owner && <span className="key-owner">{t('keys.of', { user: owner })}</span>}
        <span className={`key-status key-status-${k.status}`}>{t(k.status === 'active' ? 'keys.active' : k.status === 'expired' ? 'keys.statusExpired' : 'keys.revoked')}</span>
      </div>
      <dl className="key-meta">
        {row('keys.permissions', t(k.canWrite ? 'keys.readWrite' : 'keys.readOnly'))}
        {row('keys.folders', k.folders.length === 0 ? t('keys.foldersAllShort') : <span className="key-folders">{k.folders.map((f) => <span key={f} className="mono">{f}/</span>)}</span>)}
        {row('keys.expiry', expiry)}
        {row('keys.lastUsed', k.lastUsedAt ? t('keys.lastUsedAt', { date: dates.dateTime(k.lastUsedAt), via: viaLabel(t, k.lastVia) }) : t('keys.neverUsed'))}
        {k.revokedAt && row('keys.revokedAt', dates.dateTime(k.revokedAt))}
        {row('keys.key', <span className="mono">thoth_…{k.last4}</span>)}
      </dl>
      {actions && <div className="key-actions">{actions}</div>}
    </li>
  )
}

/** A switch that saves at once; locked ones say why. */
function Toggle({ label, hint, value, disabled, onChange }: { label: string; hint: string; value: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
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
      {canCreate && k.status === 'active' && <Button className="btn" onPress={() => setOpen({ kind: 'edit', key: k })}>{t('keys.edit')}</Button>}
      <Button className="btn btn-danger" onPress={() => setOpen({ kind: 'revoke', key: k, owner: null })}>{t('keys.revoke')}</Button>
    </>)} />
  )
  const theirs = (k: KeyWithUser) => (
    <KeyCard key={k.id} k={k} owner={k.user.username} actions={k.status === 'revoked' ? null : (
      <Button className="btn btn-danger" onPress={() => setOpen({ kind: 'revoke', key: k, owner: k.user.username })}>{t('keys.revoke')}</Button>
    )} />
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
        </Modal>
      </ModalOverlay>
    </>
  )
}
