// UI boot: first start → login → application. At /oauth/authorize, the
// application is the OAuth consent page (Consent.tsx), after signing in.
import { useEffect, useState } from 'react'
import { ApiError, api, type User } from './api.ts'
import { useT } from './i18n.tsx'
import { Login, Setup } from './Gate.tsx'
import { Shell } from './Shell.tsx'
import { Consent } from './Consent.tsx'

/** The OAuth authorization page: the server checked the request and serves the UI there. */
const consent = location.pathname === '/oauth/authorize'

type State =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'login'; notice: string | null }
  | { kind: 'app'; user: User }
  | { kind: 'offline' }

export function App() {
  const t = useT()
  const [state, setState] = useState<State>({ kind: 'loading' })

  async function boot() {
    setState({ kind: 'loading' })
    try {
      if ((await api.setupNeeded()).needed) return setState({ kind: 'setup' })
      const { user } = await api.me()
      setState({ kind: 'app', user })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState({ kind: 'login', notice: null })
      else setState({ kind: 'offline' })
    }
  }

  useEffect(() => { void boot() }, [])

  switch (state.kind) {
    case 'loading':
      return <p className="empty">{t('common.loading')}</p>
    case 'offline':
      return (
        <div className="gate"><div className="gate-card">
          <p role="alert">{t('error.network')}</p>
          <button className="btn" onClick={() => void boot()}>{t('common.retry')}</button>
        </div></div>
      )
    case 'setup':
      return <Setup onDone={(user) => setState({ kind: 'app', user })} />
    case 'login':
      return <Login notice={state.notice} intro={consent ? t('consent.signIn') : undefined} onDone={(user) => setState({ kind: 'app', user })} />
    case 'app':
      if (consent) return <Consent user={state.user} onSignOut={() => { void api.logout().finally(() => setState({ kind: 'login', notice: null })) }} />
      return (
        <Shell
          user={state.user}
          onLogout={() => { void api.logout().finally(() => setState({ kind: 'login', notice: null })) }}
          onUnauthorized={() => setState({ kind: 'login', notice: t('error.unauthorized') })}
        />
      )
  }
}
