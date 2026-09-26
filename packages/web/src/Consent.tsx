// The OAuth consent page (m3 §7), at /oauth/authorize: a remote client
// (claude.ai, mcp-remote…) sent the person here to ask for access to their
// notes through MCP. They sign in if needed (App.tsx), see who asks and where
// it will go back to, and choose as for a new key (D-035.3): read-only and
// every folder unless they say otherwise. Approving makes an authorization, a
// key of theirs named after the client, which «Agents and API» lists and can
// revoke. The server checked the request before this page loaded; it checks
// it again with the answer.
import { useEffect, useState, type FormEvent } from 'react'
import { Button } from 'react-aria-components'
import { ApiError, api, type OAuthRequest, type User } from './api.ts'
import { FolderPicker, allFolders } from './Agents.tsx'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { Brand, Icon, ThemeToggle } from './ui.tsx'
import './actions.css'
import './agents.css'
import './consent.css'

/** The authorization request: this page's own query string. */
const query = () => location.search.replace(/^\?/, '')

const PROBLEMS: Record<string, MessageKey> = {
  invalid_client: 'consent.invalidClient',
  invalid_redirect_uri: 'consent.invalidRedirect',
  invalid_client_metadata: 'consent.clientMetadata',
  not_found: 'consent.unavailable',
  invalid: 'consent.invalidRequest',
}

/** The host of the request's `client_id`, when it's a URL (a client described by its metadata document). */
function clientIdHost(): string {
  try { return new URL(new URLSearchParams(query()).get('client_id') ?? '').hostname } catch { return '' }
}

/** Whether the answer goes back to a program on this same computer (a loopback address). */
function toLoopback(uri: string): boolean {
  try { return ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(uri).hostname) } catch { return false }
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="gate consent">
      <div className="gate-corner"><ThemeToggle /></div>
      <div className="gate-card consent-card">
        <Brand size={28} />
        {children}
      </div>
    </main>
  )
}

export function Consent({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const t = useT()
  const [req, setReq] = useState<OAuthRequest | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [canWrite, setCanWrite] = useState(false)
  const [some, setSome] = useState(false)
  const [folders, setFolders] = useState<string[]>([])
  const [all, setAll] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.oauthRequest(query()).then((r) => { if (live) setReq(r) }, (err: unknown) => {
      if (!live) return
      const code = err instanceof ApiError ? err.code : 'internal'
      setProblem(code in PROBLEMS ? t(PROBLEMS[code]!, { host: clientIdHost() }) : errorText(t, err))
    })
    api.tree().then((r) => { if (live) setAll(allFolders(r.notes, r.folders)) }, () => { if (live) setAll([]) })
    return () => { live = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (approve: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { redirect } = await api.oauthDecide(query(), approve ? { approve, canWrite, folders: some ? folders : [] } : { approve })
      setLeaving(true)
      location.assign(redirect)
    } catch (err) {
      setError(errorText(t, err))
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void decide(true) }

  if (problem) {
    return (
      <Frame>
        <h1>{t('consent.problemTitle')}</h1>
        <p role="alert">{problem}</p>
        <p><a href="/">{t('consent.toThoth')}</a></p>
      </Frame>
    )
  }
  if (!req) return <Frame><p>{t('common.loading')}</p></Frame>
  if (leaving) return <Frame><p role="status">{t('consent.leaving', { client: req.client.name })}</p></Frame>

  const noneChosen = some && folders.length === 0
  return (
    <Frame>
      <h1>{t('consent.title', { client: req.client.name })}</h1>
      <p>{t('consent.intro', { user: user.username })}</p>
      <dl className="consent-who">
        <div><dt>{t('consent.client')}</dt><dd>{req.client.name}</dd></div>
        {req.client.host
          ? <div><dt>{t('consent.domain')}</dt><dd><b className="mono">{req.client.host}</b><span className="hint">{t('consent.domainHint')}</span></dd></div>
          : <div><dt>{t('consent.domain')}</dt><dd><span className="hint">{t('consent.selfRegistered')}</span></dd></div>}
        <div><dt>{t('consent.returnsTo')}</dt><dd className="mono">{req.client.redirectUri}</dd></div>
      </dl>
      {toLoopback(req.client.redirectUri) && <p className="hint" role="note">{t('consent.loopback')}</p>}
      {!req.canAuthorize ? (
        <>
          <p className="key-locked" role="note">{Icon.alert}<span>{t('consent.membersOff')}</span></p>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="consent-actions">
            <Button className="btn btn-xl" onPress={() => void decide(false)} isDisabled={busy}>{t('consent.deny')}</Button>
          </div>
        </>
      ) : (
        <form className="consent-form" onSubmit={submit}>
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
          <p className="hint">{t('consent.revocable')}</p>
          {error && <p className="error-text" role="alert">{error}</p>}
          {noneChosen && <p className="hint">{t('keys.foldersNeeded')}</p>}
          <div className="consent-actions">
            <Button className="btn btn-xl" onPress={() => void decide(false)} isDisabled={busy}>{t('consent.deny')}</Button>
            <Button type="submit" className="btn btn-primary btn-xl" isDisabled={busy || noneChosen}>{t('consent.approve')}</Button>
          </div>
        </form>
      )}
      <p className="small consent-as">
        {t('consent.as', { user: user.username })}{' '}
        <Button className="link-button" onPress={onSignOut}>{t('consent.notYou')}</Button>
      </p>
    </Frame>
  )
}
