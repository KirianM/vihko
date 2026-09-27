// Settings → «Account»: one's own password (the current one is asked for, and
// every other session ends) and sessions (which browser, when it was last
// used; close one, or all the others). Reached from the preferences, like the
// other settings pages. (The second factor, D-036, goes here too: piece T.)
import { useEffect, useState, type FormEvent } from 'react'
import { Button, FieldError, Form, Input, Label, TextField } from 'react-aria-components'
import { ApiError, api, type SessionInfo, type User } from './api.ts'
import { errorText, useT } from './i18n.tsx'
import { useDates } from './history/ui.tsx'
import { SearchButton } from './Palette.tsx'
import { MenuButton, ThemeToggle } from './ui.tsx'
import './agents.css'
import './users.css'

/** «Firefox · Linux» from a User-Agent (product names aren't translated); null if it says nothing known. */
export function browserOf(ua: string | null): string | null {
  if (!ua) return null
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null
  return [browser, os].filter(Boolean).join(' · ') || null
}

function PasswordForm({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const password = String(f.get('password'))
    setDone(false)
    if (password !== String(f.get('repeat'))) return setError(t('invite.mismatch'))
    setBusy(true)
    setError(null)
    try {
      await api.changePassword(String(f.get('current')), password)
      form.reset()
      setDone(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setError(errorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Form className="account-form" onSubmit={submit}>
      <TextField className="field" name="current" type="password" isRequired autoComplete="current-password">
        <Label>{t('account.current')}</Label>
        <Input />
      </TextField>
      <TextField className="field" name="password" type="password" isRequired minLength={10} autoComplete="new-password">
        <Label>{t('account.new')}</Label>
        <Input />
        <span className="hint">{t('field.passwordHint')}</span>
        <FieldError className="error-text" />
      </TextField>
      <TextField className="field" name="repeat" type="password" isRequired minLength={10} autoComplete="new-password">
        <Label>{t('invite.repeat')}</Label>
        <Input />
        <FieldError className="error-text" />
      </TextField>
      {error && <p className="error-text" role="alert">{error}</p>}
      {done && <p className="account-done" role="status">{t('account.changed')}</p>}
      <div className="account-actions">
        <Button type="submit" className="btn btn-primary" isDisabled={busy}>{t('account.change')}</Button>
        <span className="hint">{t('account.changeHint')}</span>
      </div>
    </Form>
  )
}

export function AccountPage({ user, onUnauthorized }: { user: User; onUnauthorized: () => void }) {
  const t = useT()
  const dates = useDates()
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  }
  const load = () => api.sessions().then(setSessions, fail)
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const end = async (s: SessionInfo) => {
    setError(null)
    try { await api.endSession(s.id) } catch (err) { fail(err) }
    void load()
  }
  const endOthers = async () => {
    setError(null)
    try { await api.endOtherSessions() } catch (err) { fail(err) }
    void load()
  }
  const others = (sessions ?? []).filter((s) => !s.current).length

  return (
    <>
      <header className="main-head">
        <MenuButton />
        <span className="spacer" />
        <SearchButton />
        <ThemeToggle />
      </header>
      <div className="alerts-page settings-page">
        <h1>{t('account.title')}</h1>
        <p className="alerts-intro">{t('account.intro', { user: user.username, role: t(user.role === 'admin' ? 'role.admin' : 'role.member') })}</p>

        <section className="settings-section" aria-labelledby="account-password">
          <h2 id="account-password">{t('account.password')}</h2>
          <PasswordForm onUnauthorized={onUnauthorized} />
        </section>

        {/* The second factor (D-036) goes here, between the password and the sessions: piece T. */}

        <section className="settings-section" aria-labelledby="account-sessions">
          <div className="settings-head">
            <h2 id="account-sessions">{t('account.sessions')}</h2>
            <span className="spacer" />
            {others > 0 && <Button className="btn" onPress={() => void endOthers()}>{t('account.endOthers')}</Button>}
          </div>
          <p className="hint">{t('account.sessionsHint')}</p>
          {error && <p className="error-text" role="alert">{error}</p>}
          {sessions === null ? <p className="hint">{t('common.loading')}</p> : (
            <ul className="sessions">
              {sessions.map((s) => (
                <li key={s.id} className="session">
                  <div className="session-text">
                    <span className="session-name">
                      {browserOf(s.userAgent) ?? t('account.unknownBrowser')}
                      {s.current && <span className="session-here">{t('account.thisSession')}</span>}
                    </span>
                    <span className="hint">{t('account.sessionTimes', { start: dates.dateTime(s.createdAt), seen: dates.dateTime(s.lastSeenAt) })}</span>
                  </div>
                  {!s.current && <Button className="btn" onPress={() => void end(s)}>{t('account.end')}</Button>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
