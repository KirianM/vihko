// Screens without a session: first start (create the admin) and login.
import { useState, type FormEvent } from 'react'
import { Button, FieldError, Form, Input, Label, TextField } from 'react-aria-components'
import { ApiError, api, type User } from './api.ts'
import { errorText, useT } from './i18n.tsx'
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

export function Setup({ onDone }: { onDone: (u: User) => void }) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
      setError(errorText(t, err))
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
        {error && <p className="error-text" role="alert">{error}</p>}
        <Button type="submit" className="btn btn-primary btn-xl" isDisabled={busy}>{t('setup.submit')}</Button>
      </Form>
      <p className="small">{t('setup.closed')}</p>
    </Frame>
  )
}

export function Login({ onDone, notice }: { onDone: (u: User) => void; notice?: string | null }) {
  const t = useT()
  const [error, setError] = useState<string | null>(notice ?? null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const { user } = await api.login(String(f.get('username')), String(f.get('password')))
      onDone(user)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('login.failed') : errorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame>
      <h1>{t('login.title')}</h1>
      <Form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <TextField className="field" name="username" isRequired autoComplete="username">
          <Label>{t('field.username')}</Label>
          <Input />
        </TextField>
        <TextField className="field" name="password" type="password" isRequired autoComplete="current-password">
          <Label>{t('field.password')}</Label>
          <Input />
        </TextField>
        {error && <p className="error-text" role="alert">{error}</p>}
        <Button type="submit" className="btn btn-primary btn-xl" isDisabled={busy}>{t('login.submit')}</Button>
      </Form>
    </Frame>
  )
}
