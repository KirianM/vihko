// Settings → «Account»: the UI's language (saved in the account), one's own
// password (the current one is asked for, and
// every other session ends), the second factor (D-036: set it up, change the
// app, new recovery codes, turn it off while the admin doesn't require it;
// with the policy `disabled`, only whoever already has one sees it, D-040 3.4a)
// and sessions (which browser, when it was last used; close one, or all the
// others); at the end, vihko's version. Reached from the preferences, like the
// other settings pages.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, FieldError, Form, Heading, Input, Label, Modal, ModalOverlay, TextField } from 'react-aria-components'
import { ApiError, api, type SessionInfo, type TwoFactorInfo, type User } from './api.ts'
import { isLanguage, LANGUAGES } from '@vihko/core/languages'
import { errorText, LANGUAGE_NAMES, useLanguageChoice, useT } from './i18n.tsx'
import { useChooseLanguage } from './language.ts'
import { useDates } from './history/ui.tsx'
import { SearchButton } from './Palette.tsx'
import { CodeField, RecoveryCodes, SetupForm, codeError } from './TwoFactor.tsx'
import { MenuButton, ThemeToggle } from './ui.tsx'
import './actions.css'
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

type TwoFactorDialog = 'setup' | 'recovery' | 'disable'

/**
 * Setting it up: the password first, then the QR code and a first code, then
 * the recovery codes. Changing the app: the same, but a code of the one in
 * force (the app's, or a recovery code) instead of the password (D-046.3).
 */
function SetupDialog({ replacing, onClose, onDone }: { replacing: boolean; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [secret, setSecret] = useState('')
  const [started, setStarted] = useState<Awaited<ReturnType<typeof api.startTwoFactor>> | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try { setStarted(await api.startTwoFactor(replacing ? { code: secret.trim() } : { password: secret })) } catch (err) { setError(codeError(t, err)) }
    setBusy(false)
  }
  let body: ReactNode
  if (codes) body = <RecoveryCodes codes={codes} done={t('twofa.codesDone')} onDone={onDone} />
  else if (started) body = <SetupForm load={() => Promise.resolve(started)} enable={api.enableTwoFactor} onEnabled={setCodes} />
  else {
    body = (
      <form className="account-form" onSubmit={start}>
        <p className="dialog-text">{t(replacing ? 'twofa.replaceIntro' : 'twofa.setupIntro')}</p>
        {replacing
          ? <CodeField recovery label={t('twofa.codeOrRecovery')} hint={t('twofa.codeOrRecoveryHint')} value={secret} onChange={setSecret} autoFocus />
          : (
            <TextField className="field" type="password" isRequired value={secret} onChange={setSecret} autoComplete="current-password" autoFocus>
              <Label>{t('account.current')}</Label>
              <Input />
            </TextField>
          )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="account-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className="btn btn-primary" isDisabled={busy || !secret.trim()}>{t('twofa.next')}</Button>
        </div>
      </form>
    )
  }
  return (
    <Dialog className="dialog key-dialog" aria-label={t(codes ? 'twofa.codesTitle' : replacing ? 'twofa.replaceTitle' : 'twofa.setupTitle')}>
      <div className="dialog-fields">
        <Heading slot="title" className="dialog-title">{t(codes ? 'twofa.codesTitle' : replacing ? 'twofa.replaceTitle' : 'twofa.setupTitle')}</Heading>
        {body}
      </div>
      {started && !codes && (
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
        </div>
      )}
    </Dialog>
  )
}

/** A dialog that asks for one secret (the app's code or a recovery code, or the password) and then does something. */
function AskDialog({ title, text, label, hint, recovery, confirm, danger, onClose, onConfirm }: {
  title: string
  text: string
  label: string
  hint?: string
  recovery?: boolean
  confirm: string
  danger?: boolean
  onClose: () => void
  onConfirm: (value: string) => Promise<void>
}) {
  const t = useT()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onConfirm(value.trim())
    } catch (err) {
      setError(codeError(t, err))
      setBusy(false)
    }
  }
  return (
    <Dialog className="dialog dialog-narrow">
      <form onSubmit={submit}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{title}</Heading>
          <p className="dialog-text">{text}</p>
          {recovery
            ? <CodeField recovery label={label} hint={hint} value={value} onChange={setValue} autoFocus />
            : (
              <TextField className="field" type="password" isRequired value={value} onChange={setValue} autoComplete="current-password" autoFocus>
                <Label>{label}</Label>
                <Input />
                {hint && <span className="hint">{hint}</span>}
              </TextField>
            )}
        </div>
        {error && <p className="error-text dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button className="btn" onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" className={danger ? 'btn btn-danger' : 'btn btn-primary'} isDisabled={busy || !value.trim()}>{confirm}</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** One's own second factor, unless the admin turned it off for new setups and they have none. */
function TwoFactorSection({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT()
  const dates = useDates()
  const [info, setInfo] = useState<TwoFactorInfo | null>(null)
  const [open, setOpen] = useState<TwoFactorDialog | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api.twoFactor().then(setInfo, (err) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized()
    setError(errorText(t, err))
  })
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { setOpen(null); setCodes(null); void load() }

  if (!info) return error ? <p className="error-text" role="alert">{error}</p> : null
  if (info.policy === 'disabled' && !info.enabled) return null
  const on = info.enabled

  let dialog: ReactNode = null
  if (open === 'setup') dialog = <SetupDialog replacing={on} onClose={close} onDone={close} />
  else if (open === 'recovery' && codes) {
    dialog = (
      <Dialog className="dialog key-dialog" aria-label={t('twofa.codesTitle')}>
        <div className="dialog-fields">
          <Heading slot="title" className="dialog-title">{t('twofa.codesTitle')}</Heading>
          <RecoveryCodes codes={codes} done={t('twofa.codesDone')} onDone={close} />
        </div>
      </Dialog>
    )
  } else if (open === 'recovery') {
    dialog = <AskDialog title={t('twofa.newCodesTitle')} text={t('twofa.newCodesBody')} label={t('twofa.codeOrRecovery')} hint={t('twofa.codeOrRecoveryHint')} recovery
      confirm={t('twofa.newCodesConfirm')} onClose={close} onConfirm={async (v) => setCodes(await api.newRecoveryCodes(v))} />
  } else if (open === 'disable') {
    dialog = <AskDialog title={t('twofa.disableTitle')} text={t('twofa.disableBody')} label={t('twofa.codeOrRecovery')} recovery danger
      confirm={t('twofa.disableConfirm')} onClose={close} onConfirm={async (v) => { await api.disableTwoFactor(v); close() }} />
  }

  return (
    <section className="settings-section" aria-labelledby="account-2fa">
      <h2 id="account-2fa">{t('twofa.title')}</h2>
      {on ? (
        <>
          <p className="twofa-state">
            <span className="twofa-on">{t('twofa.on')}</span>
            {info.enabledAt && t('twofa.onSince', { date: dates.dateTime(info.enabledAt) })}
          </p>
          <p className={info.recoveryCodesLeft <= 3 ? 'hint twofa-low' : 'hint'}>
            {t(info.recoveryCodesLeft === 1 ? 'twofa.recoveryLeftOne' : 'twofa.recoveryLeft', { n: info.recoveryCodesLeft })}
          </p>
          <div className="twofa-actions">
            <Button className="btn" onPress={() => setOpen('recovery')}>{t('twofa.newCodes')}</Button>
            <Button className="btn" onPress={() => setOpen('setup')}>{t('twofa.replace')}</Button>
            {info.policy !== 'required' && <Button className="btn btn-danger" onPress={() => setOpen('disable')}>{t('twofa.disable')}</Button>}
          </div>
          {info.policy === 'required' && <p className="hint">{t('twofa.requiredHint')}</p>}
          {info.policy === 'disabled' && <p className="hint">{t('twofa.disabledKeep')}</p>}
        </>
      ) : (
        <>
          <p className="hint">{t('twofa.offIntro')}</p>
          {info.policy === 'required' && <p className="hint">{t('twofa.requiredNext')}</p>}
          <div className="twofa-actions">
            <Button className="btn btn-primary" onPress={() => setOpen('setup')}>{t('twofa.enable')}</Button>
          </div>
        </>
      )}
      <ModalOverlay className="modal-overlay" isOpen={open !== null} isDismissable={open !== 'setup' && !codes} onOpenChange={(o) => { if (!o) close() }}>
        <Modal className="modal">{dialog}</Modal>
      </ModalOverlay>
    </section>
  )
}

/**
 * The UI's language: automatic (the browser's) or one of them, each named in
 * itself so that anyone finds theirs whatever the UI is in now. It's saved in
 * the account and applied at once.
 */
function LanguageSection({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useT()
  const { choice } = useLanguageChoice()
  const choose = useChooseLanguage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      await choose(isLanguage(value) ? value : null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized()
      setError(errorText(t, err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="settings-section" aria-labelledby="account-language">
      <h2 id="account-language">{t('account.language')}</h2>
      <div className="account-form">
        <div className="field">
          <select className="select" aria-labelledby="account-language" aria-describedby="account-language-hint"
            value={choice ?? AUTO} disabled={busy} onChange={(e) => void change(e.target.value)}>
            <option value={AUTO}>{t('account.languageAuto')}</option>
            {LANGUAGES.map((l) => <option key={l} value={l} lang={l}>{LANGUAGE_NAMES[l]}</option>)}
          </select>
          <span id="account-language-hint" className="hint">{t('account.languageHint')}</span>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    </section>
  )
}

/** The value of «automatic» in the language list: none of the languages. */
const AUTO = 'auto'

export function AccountPage({ user, onUnauthorized }: { user: User; onUnauthorized: () => void }) {
  const t = useT()
  const dates = useDates()
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  // Only a line at the end: without it the page loses nothing.
  useEffect(() => { api.config().then((c) => setVersion(c.version ?? null), () => {}) }, [])

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

        <LanguageSection onUnauthorized={onUnauthorized} />

        <section className="settings-section" aria-labelledby="account-password">
          <h2 id="account-password">{t('account.password')}</h2>
          <PasswordForm onUnauthorized={onUnauthorized} />
        </section>

        <TwoFactorSection onUnauthorized={onUnauthorized} />

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

        {version && (
          <section className="settings-section" aria-labelledby="account-about">
            <h2 id="account-about">{t('account.about')}</h2>
            <p className="hint">{t('account.version', { version })}</p>
          </section>
        )}
      </div>
    </>
  )
}
