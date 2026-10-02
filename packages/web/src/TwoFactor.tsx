// The second factor in the UI: setting it up (the QR code, the secret
// as text and the app's link; nothing is theirs until a code from it is
// verified, as Trilium does), the recovery codes (shown once, to copy or
// download), the second step of a sign-in, and the confirmation that
// creating a key or approving an OAuth client asks for (the current code, or
// the password without a second factor).
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Form, Input, Label, Text, TextField } from 'react-aria-components'
import { ApiError, api, type SecondStep, type TwoFactorSetup, type User } from './api.ts'
import { CopyButton } from './Agents.tsx'
import { errorText, useT } from './i18n.tsx'
import { Icon } from './ui.tsx'
import './agents.css'
import './consent.css'
import './twofactor.css'

type Translate = ReturnType<typeof useT>

/** What a code the server refused means to the person. */
export function codeError(t: Translate, err: unknown): string {
  if (err instanceof ApiError && err.code === 'invalid_code') return t('twofa.wrongCode')
  return errorText(t, err)
}

/** The setup's QR code, dark on light in either theme: that's what scanners read best. */
export function QrImage({ qr, label }: { qr: NonNullable<TwoFactorSetup['qr']>; label: string }) {
  const side = qr.size + 8 // four modules of quiet zone on each side
  return (
    <svg className="qr" viewBox={`-4 -4 ${side} ${side}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect className="qr-light" x={-4} y={-4} width={side} height={side} />
      <path className="qr-dark" d={qr.path} />
    </svg>
  )
}

/** A field for a six-digit code (or, with `recovery`, a recovery code). */
export function CodeField({ name = 'code', label, hint, recovery, autoFocus, value, onChange }: {
  name?: string
  label: string
  hint?: string
  recovery?: boolean
  autoFocus?: boolean
  value?: string
  onChange?: (v: string) => void
}) {
  return (
    <TextField className="field" name={name} isRequired autoFocus={autoFocus} value={value} onChange={onChange}
      autoComplete={recovery ? 'off' : 'one-time-code'} inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 16 : 7}>
      <Label>{label}</Label>
      <Input className={recovery ? 'mono' : 'mono code-input'} spellCheck={false} />
      {hint && <Text slot="description" className="hint">{hint}</Text>}
    </TextField>
  )
}

/**
 * Setting it up: scan (or type) the secret, then a code from the app. Only
 * that code makes it theirs; `enable` returns the recovery codes.
 */
export function SetupForm({ load, enable, onEnabled }: {
  load: () => Promise<TwoFactorSetup>
  enable: (code: string) => Promise<string[]>
  onEnabled: (codes: string[]) => void
}) {
  const t = useT()
  const [data, setData] = useState<TwoFactorSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    load().then((d) => { if (live) setData(d) }, (err) => { if (live) setError(errorText(t, err)) })
    return () => { live = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const code = String(new FormData(e.currentTarget).get('code') ?? '')
    setBusy(true)
    setError(null)
    try {
      onEnabled(await enable(code))
    } catch (err) {
      setError(codeError(t, err))
      setBusy(false)
    }
  }

  if (!data) return error ? <p className="error-text" role="alert">{error}</p> : <p className="hint">{t('common.loading')}</p>
  return (
    <Form className="twofa-setup" onSubmit={submit}>
      <ol className="twofa-steps">
        <li>
          <span className="twofa-step">{t('twofa.scan')}</span>
          <span className="hint">{t('twofa.apps')}</span>
          {data.qr ? <QrImage qr={data.qr} label={t('twofa.qrLabel')} /> : <span className="hint">{t('twofa.noQr')}</span>}
        </li>
        <li>
          <span className="twofa-step">{t('twofa.orType')}</span>
          <div className="token-row">
            <code className="token twofa-secret" aria-label={t('twofa.secretLabel')} tabIndex={0}>{data.secret}</code>
            <CopyButton text={data.secret.replace(/ /g, '')} label={t('twofa.copySecret')} />
          </div>
          <a className="twofa-open" href={data.uri}>{t('twofa.openApp')}</a>
        </li>
        <li>
          <span className="twofa-step">{t('twofa.enterCode')}</span>
          <CodeField label={t('twofa.code')} hint={t('twofa.codeHint')} />
        </li>
      </ol>
      {error && <p className="error-text" role="alert">{error}</p>}
      <Button type="submit" className="btn btn-primary" isDisabled={busy}>{t('twofa.activate')}</Button>
    </Form>
  )
}

/** The recovery codes, shown this once: copy them, download them, and say they're kept. */
export function RecoveryCodes({ codes, done, onDone }: { codes: string[]; done: string; onDone: () => void }) {
  const t = useT()
  const text = `${t('twofa.fileHeader')}\n\n${codes.join('\n')}\n`
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'vihko-recovery-codes.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="twofa-codes-block">
      <p className="key-once" role="note">{Icon.alert}<span>{t('twofa.codesOnce')}</span></p>
      <ul className="twofa-codes" aria-label={t('twofa.codesLabel')}>
        {codes.map((c) => <li key={c} className="mono">{c}</li>)}
      </ul>
      <div className="twofa-codes-actions">
        <CopyButton text={codes.join('\n')} label={t('twofa.copyCodes')} />
        <Button className="btn" onPress={download}>{t('twofa.downloadCodes')}</Button>
        <span className="spacer" />
        <Button className="btn btn-primary" onPress={onDone}>{done}</Button>
      </div>
    </div>
  )
}

/**
 * The second step of a sign-in (the password was right): a code, or setting
 * it up if the admin requires it and they have none. `onRestart`: the
 * sign-in expired, back to the password with this message.
 */
export function SecondStepForm({ step, onDone, onRestart }: { step: SecondStep; onDone: (u: User) => void; onRestart: (message: string) => void }) {
  const t = useT()
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wait, setWait] = useState(0)
  /** After a recovery code: how many are left, said before going in. */
  const [left, setLeft] = useState<{ user: User; n: number } | null>(null)
  /** Set up (the admin requires it): the recovery codes, before going in. */
  const [codes, setCodes] = useState<{ user: User; codes: string[] } | null>(null)

  useEffect(() => {
    if (wait <= 0) return
    const timer = setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(timer)
  }, [wait])

  const failed = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'login_expired') return onRestart(t('error.login_expired'))
    if (err instanceof ApiError && err.code === 'too_many_attempts') {
      setWait(err.retryAfter ?? 1)
      return setError(t('twofa.tooMany'))
    }
    setError(codeError(t, err))
  }

  if (left) {
    return (
      <>
        <h1>{t('twofa.recoveryUsedTitle')}</h1>
        <p role="status">{t(left.n === 1 ? 'twofa.recoveryLeftOne' : 'twofa.recoveryLeft', { n: left.n })}</p>
        <Button className="btn btn-primary btn-xl" onPress={() => onDone(left.user)} autoFocus>{t('twofa.continue')}</Button>
      </>
    )
  }
  if (codes) {
    return (
      <>
        <h1>{t('twofa.codesTitle')}</h1>
        <p>{t('twofa.codesIntro')}</p>
        <RecoveryCodes codes={codes.codes} done={t('twofa.continue')} onDone={() => onDone(codes.user)} />
      </>
    )
  }
  if (step.step === 'setup') {
    return (
      <>
        <h1>{t('twofa.requiredTitle')}</h1>
        <p>{t('twofa.requiredIntro', { user: step.username })}</p>
        <SetupForm load={() => api.setupPending(step.pending).catch((err) => { failed(err); throw err })}
          enable={async (code) => {
            try {
              const r = await api.enablePending(step.pending, code)
              setCodes({ user: r.user, codes: r.recoveryCodes })
              return r.recoveryCodes
            } catch (err) {
              if (err instanceof ApiError && err.code === 'login_expired') onRestart(t('error.login_expired'))
              throw err
            }
          }}
          onEnabled={() => {}} />
      </>
    )
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const code = String(new FormData(e.currentTarget).get('code') ?? '')
    setBusy(true)
    setError(null)
    try {
      const r = await api.loginCode(step.pending, code)
      if (r.recoveryCodesLeft !== undefined) setLeft({ user: r.user, n: r.recoveryCodesLeft })
      else onDone(r.user)
    } catch (err) {
      failed(err)
      setBusy(false)
    }
  }
  return (
    <>
      <h1>{t('twofa.stepTitle')}</h1>
      <p>{t(recovery ? 'twofa.stepRecoveryIntro' : 'twofa.stepIntro', { user: step.username })}</p>
      <Form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <CodeField key={recovery ? 'recovery' : 'code'} recovery={recovery} autoFocus label={t(recovery ? 'twofa.recoveryCode' : 'twofa.code')} />
        {error && <p className="error-text" role="alert">{error}</p>}
        <Button type="submit" className="btn btn-primary btn-xl" isDisabled={busy || wait > 0}>{wait > 0 ? t('twofa.retryIn', { n: wait }) : t('twofa.verify')}</Button>
      </Form>
      <p className="small">
        <Button className="link-button" onPress={() => { setRecovery(!recovery); setError(null) }}>{t(recovery ? 'twofa.useApp' : 'twofa.useRecovery')}</Button>
      </p>
    </>
  )
}

/**
 * What confirms at the moment, for this person, now: `code` or `password`;
 * `none` while a confirmation of this browser session lasts (the server's
 * window: nothing is asked, and nothing is sent); null while it's asked.
 * When the window ends, it says what to ask for again.
 */
export type ConfirmHow = 'code' | 'password' | 'none' | null

/** Ends the window this long before the server says, so that a clock a little ahead never sends an action unconfirmed. */
const WINDOW_MARGIN_MS = 30_000

export function useConfirmWith(): ConfirmHow {
  const [info, setInfo] = useState<{ how: 'code' | 'password'; until: number | null } | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    let live = true
    api.twoFactor().then(
      (r) => { if (live) setInfo({ how: r.confirmWith, until: r.confirmNeeded || !r.confirmedUntil ? null : Date.parse(r.confirmedUntil) - WINDOW_MARGIN_MS }) },
      () => { if (live) setInfo({ how: 'password', until: null }) },
    )
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (info?.until == null) return
    const left = info.until - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setTick((n) => n + 1), left + 50)
    return () => clearTimeout(timer)
  }, [info])
  if (!info) return null
  return info.until !== null && Date.now() < info.until ? 'none' : info.how
}

/** Whether a confirmation can be sent now: inside the window nothing is needed; otherwise what was typed. */
export const confirmReady = (how: ConfirmHow, secret: string) => how === 'none' || (how !== null && secret.trim() !== '')

/** The confirmation at the moment (a session left open is not enough): the current code, or the password without a second factor. */
export function ConfirmField({ how, value, onChange, hint }: { how: ConfirmHow; value: string; onChange: (v: string) => void; hint: string }) {
  const t = useT()
  if (how === null || how === 'none') return null
  if (how === 'code') return <CodeField name="confirm" label={t('twofa.confirmCode')} hint={hint} value={value} onChange={onChange} />
  return (
    <TextField className="field" name="confirm" type="password" isRequired value={value} onChange={onChange} autoComplete="current-password">
      <Label>{t('twofa.confirmPassword')}</Label>
      <Input />
      <Text slot="description" className="hint">{hint}</Text>
    </TextField>
  )
}
