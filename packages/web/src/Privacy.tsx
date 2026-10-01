// Privacy: what leaves vihko, where to and when, in plain words (the model is
// Trilium's AI/Privacy.md). First how things stand on this server right now
// (the switches, the keys that can read, external images); then what always
// holds. Every sentence here is checked against the code: without
// integrations nothing gets in or out (the OAuth addresses don't exist
// either); a key, or an OAuth authorization, reads what its user sees within
// its folders and never anything of a note hidden from agents, which it only
// learns exists if it already has its name (`no_access`, `agent_denied`);
// with OAuth, the person who signs in authorizes, and the addresses anyone
// may call (metadata, registration) give access to nothing; the one request
// vihko makes on its own is a client's metadata document, only when someone
// signed in starts authorizing it, fenced as cimd.ts says; no telemetry, updates or
// CDNs (the page's CSP only lets the browser talk to this server, images
// linked from other sites aside); images are downloaded by URL only when a
// person asks (a key can't); external images as the server's administrator
// says (VIHKO_EXTERNAL_IMAGES), with no referrer. And one's account: what the
// admin can do to it is confirmed at the moment and told, never done quietly, the
// second factor's policy, how its secret is kept (VIHKO_SECRET_KEY,
// 3.4b) and a purge's notice to whoever wrote (3.6).
import { useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, type Integrations, type KeyInfo, type KeyWithUser, type ServerConfig, type User } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { useDates } from './history/ui.tsx'
import { SearchButton } from './Palette.tsx'
import { BackButton, Diamond, MenuButton, ThemeToggle } from './ui.tsx'
import './agents.css'
import './privacy.css'

/** A translated text with `code` spans for its {placeholders}. */
function withCode(text: string, parts: Record<string, string>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((chunk, i) => (i % 2 ? <code key={i}>{parts[chunk] ?? chunk}</code> : chunk))
}

export function PrivacyPage({ user, onUnauthorized, onAgents }: { user: User; onUnauthorized: () => void; onAgents: () => void }) {
  const t = useT()
  const dates = useDates()
  const admin = user.role === 'admin'
  const [integ, setInteg] = useState<Integrations | null>(null)
  const [keys, setKeys] = useState<(KeyInfo | KeyWithUser)[] | null>(null)
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fail = (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setError(errorText(t, err))
    }
    api.integrations().then(setInteg, fail)
    // The admin sees everyone's keys (and so what can read the whole space); a member, their own.
    ;(admin ? api.allKeys() : api.keys()).then((all) => setKeys(all.filter((k) => k.status === 'active')), fail)
    api.config().then(setConfig, fail)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const on = integ && !integ.locked ? [integ.api && 'API', integ.mcp && 'MCP'].filter(Boolean).join(' · ') : ''
  const via = (k: KeyInfo) => (k.lastVia === 'mcp' ? t('keys.viaMcp') : k.lastVia === 'oauth' ? t('keys.viaOauth') : t('keys.viaApi'))
  const reach = (k: KeyInfo) => [
    ...(k.client ? [t('privacy.keyOauth')] : []),
    t(k.canWrite ? 'privacy.keyWrites' : 'privacy.keyReads'),
    'foldersHidden' in k && k.foldersHidden
      ? (k.folders.length ? t('privacy.keyFoldersHidden', { folders: k.folders.map((f) => `${f}/`).join(', ') }) : t('privacy.keyOnlyHidden'))
      : k.folders.length ? t('privacy.keyFolders', { folders: k.folders.map((f) => `${f}/`).join(', ') }) : t('privacy.keyAll'),
    k.lastUsedAt ? t('privacy.keyUsed', { date: dates.dateTime(k.lastUsedAt), via: via(k) }) : t('privacy.keyUnused'),
  ].join(' · ')

  let now: ReactNode = <p>{t('common.loading')}</p>
  if (integ && keys) {
    if (integ.locked) now = <p>{t('privacy.nowLocked')}</p>
    else if (!on) now = <p>{t('privacy.nowOff')}</p>
    else if (keys.length === 0) now = <p>{t(admin ? 'privacy.nowNoKeysAll' : 'privacy.nowNoKeysMine', { what: on })}</p>
    else now = (<>
      <p>{t(admin ? 'privacy.nowKeysAll' : 'privacy.nowKeysMine', { what: on })}</p>
      <ul className="privacy-keys">
        {keys.map((k) => (
          <li key={k.id}>
            <Diamond />
            <span><b>{k.name}</b>{'user' in k && k.user.id !== user.id ? ` (${t('keys.of', { user: k.user.username })})` : ''}: {reach(k)}</span>
          </li>
        ))}
      </ul>
    </>)
  }
  // OAuth, when this server offers it: where, and whether apps may register themselves.
  const oauth = integ && integ.publicUrl && integ.mcp && !integ.locked
    ? <p>{withCode(t(integ.oauthRegistration ? 'privacy.nowOauth' : 'privacy.nowOauthClosed'), { url: `${integ.publicUrl}/mcp` })}</p>
    : null

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <BackButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="alerts-page settings-page privacy-page">
        <h1>{t('privacy.title')}</h1>
        <p className="alerts-intro">{t('privacy.intro')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}

        <section className="settings-section privacy-now" aria-labelledby="privacy-now">
          <h2 id="privacy-now">{t('privacy.now')}</h2>
          {now}
          {oauth}
          <p><a href="?view=agents" onClick={(e) => { e.preventDefault(); onAgents() }}>{t('privacy.manage')}</a></p>
        </section>

        <section className="settings-section" aria-labelledby="privacy-none">
          <h2 id="privacy-none">{t('privacy.noneTitle')}</h2>
          <p>{t('privacy.none')}</p>
        </section>

        <section className="settings-section" aria-labelledby="privacy-people">
          <h2 id="privacy-people">{t('privacy.peopleTitle')}</h2>
          <ul>
            <li>{t('privacy.peopleFolders')}</li>
            <li>{t('privacy.peopleManagers')}</li>
            <li>{t('privacy.peoplePersonal')}</li>
            <li>{t('privacy.peopleAdmin')}</li>
          </ul>
        </section>

        <section className="settings-section" aria-labelledby="privacy-keys">
          <h2 id="privacy-keys">{t('privacy.keysTitle')}</h2>
          <ul>
            <li>{t('privacy.keysReach')}</li>
            <li>{withCode(t('privacy.keysHidden'), { ai: 'ai: false' })}</li>
            <li>{t('privacy.keysWrite')}</li>
            <li>{withCode(t('privacy.keysVia'), { api: '/api/…', mcp: '/mcp' })}</li>
            <li>{t('privacy.keysOauth')}</li>
            <li>{t('privacy.keysLeave')}</li>
            <li>{t('privacy.keysAsk')}</li>
            <li>{t('privacy.keysCimd')}</li>
            <li>{t('privacy.keysStored')}</li>
          </ul>
        </section>

        <section className="settings-section" aria-labelledby="privacy-account">
          <h2 id="privacy-account">{t('privacy.accountTitle')}</h2>
          <ul>
            <li>{t('privacy.accountAdmin')}</li>
            <li>{t('privacy.accountPolicy')}</li>
            <li>{config === null ? t('common.loading')
              : config.secretsEncrypted ? t('privacy.accountSecretEncrypted')
                : withCode(t('privacy.accountSecretPlain'), { setting: 'VIHKO_SECRET_KEY' })}</li>
            <li>{t('privacy.accountPurge')}</li>
          </ul>
        </section>

        <section className="settings-section" aria-labelledby="privacy-telemetry">
          <h2 id="privacy-telemetry">{t('privacy.telemetryTitle')}</h2>
          <ul>
            <li>{t('privacy.telemetry')}</li>
            <li>{t('privacy.cdn')}</li>
            <li>{t('privacy.history')}</li>
          </ul>
        </section>

        <section className="settings-section" aria-labelledby="privacy-images">
          <h2 id="privacy-images">{t('privacy.imagesTitle')}</h2>
          <ul>
            <li>{t('privacy.imagesFetch')}</li>
            <li>{config === null ? t('common.loading')
              : config.externalImages === 'block' ? t('privacy.imagesBlocked')
                : withCode(t('privacy.imagesAllowed'), { setting: 'VIHKO_EXTERNAL_IMAGES=block' })}</li>
          </ul>
        </section>
      </div>
    </>
  )
}
