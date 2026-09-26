// Screens without a session: first start (create the admin) and login.
import { useEffect, useState, type FormEvent } from 'react'
import { Button, FieldError, Form, Input, Label, TextField } from 'react-aria-components'
import { ApiError, api, type User } from './api.ts'
import { errorText, useT, type MessageKey } from './i18n.tsx'
import { Brand, ThemeToggle } from './ui.tsx'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="gate">
      <div className="gate-corner"><ThemeToggle /></div>
      <div className="gate-card">
        <Brand size={28} />
        {children}
      </div>
    </main>
  )
}

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

/** `42 s`, `2 min`, `14 min 5 s`. */
function waitText(t: Translate, seconds: number): string {
  if (seconds < 60) return t('wait.seconds', { n: seconds })
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s ? t('wait.minutesSeconds', { m, s }) : t('wait.minutes', { m })
}

/**
 * A wait the server asked for (429 too_many_attempts, after too many failed
 * attempts): what to say, fixed when it arrives, and the seconds left,
 * counted down for the button, which stays off until then.
 */
function useWait() {
  const t = useT()
  const [wait, setWait] = useState<{ until: number; message: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!wait) return
    const tick = setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at >= wait.until) setWait(null)
    }, 1000)
    return () => clearInterval(tick)
  }, [wait])
  const left = wait ? Math.max(0, Math.ceil((wait.until - now) / 1000)) : 0
  return {
    left,
    message: left > 0 ? wait!.message : null,
    button: left > 0 ? t('login.retryIn', { wait: waitText(t, left) }) : null,
    /** Whether `err` asks to wait; if so, the wait starts. */
    caught(err: unknown): boolean {
      if (!(err instanceof ApiError) || err.code !== 'too_many_attempts') return false
      const seconds = err.retryAfter ?? 1
      const at = Date.now()
      setNow(at)
      setWait({ until: at + seconds * 1000, message: t('login.tooMany', { wait: waitText(t, seconds) }) })
      return true
    },
  }
}

export function Setup({ onDone }: { onDone: (u: User) => void }) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const wait = useWait()
  const tokenFromUrl = new URLSearchParams(location.search).get('token') ?? ''

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const username = String(f.get('username'))
    const password = String(f.get('password'))
    setBusy(true)
    setError(null)
    try {
      await api.setup(String(f.get('token')).trim(), username, password)
      const { user } = await api.login(username, password)
      history.replaceState(null, '', '/')
      onDone(user)
    } catch (err) {
      setError(wait.caught(err) ? null : errorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame>
      <h1>{t('setup.title')}</h1>
      <p>{t('setup.intro', { cmd: 'docker compose logs thoth' })}</p>
      <Form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <TextField className="field" name="token" isRequired defaultValue={tokenFromUrl}>
          <Label>{t('setup.token')}</Label>
          <Input className="mono" placeholder={t('setup.tokenPlaceholder')} autoComplete="off" />
          <FieldError className="error-text" />
        </TextField>
        <TextField className="field" name="username" isRequired autoComplete="username">
          <Label>{t('field.username')}</Label>
          <Input />
          <FieldError className="error-text" />
        </TextField>
        <TextField className="field" name="password" type="password" isRequired minLength={10} autoComplete="new-password">
          <Label>{t('field.password')}</Label>
          <Input />
          <span className="hint">{t('field.passwordHint')}</span>
          <FieldError className="error-text" />
        </TextField>
        {(wait.message ?? error) && <p className="error-text" role="alert">{wait.message ?? error}</p>}
        <Button type="submit" className="btn btn-primary btn-xl" isDisabled={busy || wait.left > 0}>{wait.button ?? t('setup.submit')}</Button>
      </Form>
      <p className="small">{t('setup.closed')}</p>
    </Frame>
  )
}

/** `intro`: why signing in is asked for, when it isn't just to open thoth (an OAuth authorization). */
export function Login({ onDone, notice, intro }: { onDone: (u: User) => void; notice?: string | null; intro?: string }) {
  const t = useT()
  const [error, setError] = useState<string | null>(notice ?? null)
  const [busy, setBusy] = useState(false)
  const wait = useWait()

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const { user } = await api.login(String(f.get('username')), String(f.get('password')))
      onDone(user)
    } catch (err) {
      setError(wait.caught(err) ? null : err instanceof ApiError && err.status === 401 ? t('login.failed') : errorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame>
      <h1>{t('login.title')}</h1>
      {intro && <p>{intro}</p>}
      <Form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <TextField className="field" name="username" isRequired autoComplete="username">
          <Label>{t('field.username')}</Label>
          <Input />
        </TextField>
        <TextField className="field" name="password" type="password" isRequired autoComplete="current-password">
          <Label>{t('field.password')}</Label>
          <Input />
        </TextField>
        {(wait.message ?? error) && <p className="error-text" role="alert">{wait.message ?? error}</p>}
        <Button type="submit" className="btn btn-primary btn-xl" isDisabled={busy || wait.left > 0}>{wait.button ?? t('login.submit')}</Button>
      </Form>
    </Frame>
  )
}
