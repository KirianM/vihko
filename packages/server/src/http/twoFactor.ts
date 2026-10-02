// The second factor over HTTP (twoFactor.ts).
//
// Signing in is two steps when it applies: the password (POST
// /api/auth/login, or a one-time link) gives a short-lived pending sign-in
// instead of a session, and the session comes with its second step:
//
//   { step: 'code', pending }    a TOTP code or a recovery code (POST /api/auth/login/code)
//   { step: 'setup', pending }   the policy requires it and they have none: set it up
//                                now (POST /api/auth/2fa/setup, then /api/auth/2fa/enable)
//
// A pending sign-in lives 5 minutes (15 while setting up: scanning takes a
// while), in memory, and works once; after MAX_CODE_TRIES wrong codes it's
// gone, and the password is asked again. Wrong codes count in the login limits
// (loginLimit.ts) under an account of their own for each user, which a
// right password doesn't clear: knowing the password gives no fresh free
// guesses at the code.
//
// With a session:
//   GET  /api/account/2fa                   the policy, whether it's set up, recovery codes left, and what confirms (`code` or `password`)
//   POST /api/account/2fa/setup {password}  a new secret (and its QR code) to set it up
//   POST /api/account/2fa/setup {code}      the same, to replace the authenticator: a code of the one in force
//                                           (the app's, or a recovery code), never the password
//   POST /api/account/2fa/enable {code}     verifies a code from it: now it's theirs → { recoveryCodes } (shown once)
//   POST /api/account/2fa/recovery {confirm}  new recovery codes; `confirm`: the app's code or a recovery code
//   POST /api/account/2fa/disable {code}    only while the policy isn't `required`; a code or a recovery code
//   POST /api/admin/users/:id/2fa/reset {confirm}  the vihko admin takes someone's second factor away
//
// The policy `disabled` means nobody new sets one up: whoever
// already has one is still asked for it, and may replace or turn it off.
//
// Confirming at the moment (`confirmIdentity`): approving an OAuth
// client and creating (or rotating) an agent key ask for the current TOTP
// code, or the password if the person has no second factor, even with a
// session: one left open and forgotten is not enough to hand access to a
// program. The admin's changes to someone else's account (a reset link, their
// second factor's reset, their role) and a new policy ask the same,
// so an admin never does it unseen, and the person and every other admin are told (notices.ts).
// Keys themselves never ask for a second factor.
import { createHash, randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Auth, User } from '../auth.ts'
import type { Access } from '../access.ts'
import type { AdminSettings } from '../adminSettings.ts'
import type { LoginLimiter } from '../loginLimit.ts'
import type { Notices } from '../notices.ts'
import type { TwoFactor } from '../twoFactor.ts'
import type { Users } from '../users.ts'

type Env = { Variables: { user: User; token: string; access: Access } }

/** A second step still to take after the password. */
export type PendingStep = 'code' | 'setup'

const PENDING_MS: Record<PendingStep, number> = { code: 5 * 60_000, setup: 15 * 60_000 }
const MAX_PENDING = 10_000
/** Wrong codes a pending sign-in takes before it ends. */
export const MAX_CODE_TRIES = 5

/** The account a user's second-factor attempts are counted under in the login limits (no username has a NUL). */
export function secondFactorAccount(username: string): string {
  return `\0code\0${username}`
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Sign-ins whose password was right, waiting for their second step (in memory: a restart asks for the password again). */
export class PendingSignIns {
  private readonly now: () => number
  private readonly entries = new Map<string, { userId: string; step: PendingStep; until: number; wrong: number }>()

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  create(userId: string, step: PendingStep): { token: string; expiresAt: string } {
    const now = this.now()
    for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k)
    // Only a right password makes one; still, never without bound: the oldest go first.
    while (this.entries.size >= MAX_PENDING) this.entries.delete(this.entries.keys().next().value!)
    const token = randomBytes(32).toString('base64url')
    const until = now + PENDING_MS[step]
    this.entries.set(sha256(token), { userId, step, until, wrong: 0 })
    return { token, expiresAt: new Date(until).toISOString() }
  }

  /** The pending sign-in with this token and step, if it hasn't expired. */
  get(token: unknown, step: PendingStep): { userId: string } | null {
    if (typeof token !== 'string' || !token) return null
    const e = this.entries.get(sha256(token))
    if (!e || e.step !== step) return null
    if (e.until <= this.now()) {
      this.entries.delete(sha256(token))
      return null
    }
    return { userId: e.userId }
  }

  end(token: string) {
    this.entries.delete(sha256(token))
  }

  /** A wrong code with this pending sign-in: after MAX_CODE_TRIES of them, it ends. */
  wrongCode(token: string) {
    const e = this.entries.get(sha256(token))
    if (e && ++e.wrong >= MAX_CODE_TRIES) this.entries.delete(sha256(token))
  }
}

export interface TwoFactorHttpDeps {
  auth: Auth
  users: Users
  twoFactor: TwoFactor
  settings: AdminSettings
  limiter: LoginLimiter
  /** The login limits' device cookie. */
  deviceCookie: string
  ipOf: (c: Context) => string
  tooMany: (c: Context, retryAfter: number) => Response
  /** Sets the session cookie (and the device's) of a user who just signed in. */
  signedIn: (c: Context, username: string, session: { token: string; expiresAt: Date }) => void
  /** VIHKO_PUBLIC_URL, if set: its host names the installation in the authenticator app. */
  publicUrl: string | null
  /** Notices addressed to one person: the admin's reset of someone's second factor is told. */
  notices?: Notices
  now?: () => number
}

const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409, error: string, message: string) => c.json({ error, message }, status)

export function twoFactorHttp(deps: TwoFactorHttpDeps) {
  const { auth, twoFactor, settings, limiter } = deps
  const pending = new PendingSignIns({ now: deps.now })
  const deviceOf = (c: Context, username: string) => limiter.deviceFor(getCookie(c, deps.deviceCookie), username)
  /**
   * Whether this user signs in (and confirms) with a code: they set one up.
   * The policy `disabled` only stops new ones.
   */
  const inForce = (userId: string) => twoFactor.enabled(userId)
  /** Where vihko is reached, for the authenticator app's label. */
  const host = (c: Context) => {
    try { return new URL(deps.publicUrl ?? c.req.url).host } catch { return null }
  }
  const startSession = (c: Context, user: User) => deps.signedIn(c, user.username, auth.startSession(user.id, c.req.header('user-agent')))
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const b = await c.req.json<unknown>().catch(() => null)
    return typeof b === 'object' && b !== null && !Array.isArray(b) ? b as Record<string, unknown> : {}
  }

  /**
   * One attempt at a secret (a code or a password), counted in the login
   * limits under `account`: null if it was right, the response otherwise.
   */
  const attempt = async (c: Context, account: string, username: string, check: () => Promise<string | null> | string | null, status: 400 | 401 | 403, message?: string): Promise<Response | null> => {
    const a = limiter.begin({ ip: deps.ipOf(c), account, device: deviceOf(c, username), secondFactor: account === secondFactorAccount(username) })
    if (!a.ok) return deps.tooMany(c, a.retryAfter)
    const error = await check()
    if (error) {
      const wait = a.failed()
      return wait > 0 ? deps.tooMany(c, wait) : fail(c, status, error, message ?? (error === 'wrong_password' ? 'the password is not right' : 'the code is not right, or was already used'))
    }
    a.passed()
    return null
  }
  /**
   * The first code from a secret being set up: counted like any other code.
   * Whoever holds only the session (not the password that began the setup,
   * nor the app it was scanned into) gets no free guesses at making it theirs.
   * The recovery codes if it was right; the response otherwise.
   */
  const finishSetup = async (c: Context, user: User, code: unknown): Promise<{ codes: string[] } | Response> => {
    let codes = null as string[] | null
    const refused = await attempt(c, secondFactorAccount(user.username), user.username, async () => {
      codes = await twoFactor.finishSetup(user.id, code)
      return codes ? null : 'invalid_code'
    }, 400, 'the code is not right: check the time on the device')
    return refused ?? { codes: codes! }
  }
  /** A code of theirs: TOTP, or also a recovery code (spent). Null if right; the error code otherwise. */
  const checkCode = async (userId: string, code: unknown, recovery: boolean): Promise<string | null> => {
    const r = await twoFactor.verify(userId, code, { recovery })
    return r.ok ? null : r.reason === 'used' ? 'code_used' : 'invalid_code'
  }

  /**
   * Confirms that the person with this session is there now: the current
   * TOTP code if they have a second factor, their password otherwise. Null
   * if confirmed; the response to give otherwise.
   */
  const confirmIdentity = async (c: Context<Env>, confirm: unknown): Promise<Response | null> => {
    const user = c.get('user')
    if (typeof confirm !== 'string' || !confirm) {
      return c.json({ error: 'confirmation_required', message: 'confirm with the current code (or the password, without a second factor)', with: inForce(user.id) ? 'code' : 'password' }, 400)
    }
    if (inForce(user.id)) return attempt(c, secondFactorAccount(user.username), user.username, () => checkCode(user.id, confirm, false), 403)
    return attempt(c, user.username, user.username, async () => ((await auth.checkPassword(user.id, confirm)) ? null : 'wrong_password'), 403)
  }

  return {
    /**
     * The password was right (a sign-in, or a one-time link): the session,
     * or the second step to take first.
     */
    passwordAccepted(c: Context, user: User): Response {
      const step: PendingStep | null = twoFactor.enabled(user.id) ? 'code' : settings.twoFactorPolicy() === 'required' ? 'setup' : null
      if (!step) {
        startSession(c, user)
        return c.json({ user })
      }
      const p = pending.create(user.id, step)
      return c.json({ step, pending: p.token, expiresAt: p.expiresAt, username: user.username })
    },

    confirmIdentity,

    /** The second step, without a session yet (before the session middleware). */
    publicRoutes(app: Hono<Env>) {
      /** The pending sign-in's user, if it still works and they can still sign in. */
      const who = (token: unknown, step: PendingStep) => {
        const p = pending.get(token, step)
        return p && auth.user(p.userId)
      }
      const expired = (c: Context) => fail(c, 401, 'login_expired', 'the sign-in expired: enter the password again')

      app.post('/api/auth/login/code', async (c) => {
        const b = await body(c)
        const user = who(b.pending, 'code')
        if (!user) return expired(c)
        /** With a recovery code: how many are left, for the page to say so. */
        const recovery: { left?: number } = {}
        const refused = await attempt(c, secondFactorAccount(user.username), user.username, async () => {
          const r = await twoFactor.verify(user.id, b.code, { recovery: true })
          if (r.ok && r.recovery) recovery.left = r.recoveryCodesLeft
          return r.ok ? null : r.reason === 'used' ? 'code_used' : 'invalid_code'
        }, 401)
        if (refused) {
          if (refused.status !== 429) pending.wrongCode(b.pending as string)
          return refused
        }
        pending.end(b.pending as string)
        startSession(c, user)
        return c.json({ user, ...(recovery.left === undefined ? {} : { recoveryCodesLeft: recovery.left }) })
      })

      app.post('/api/auth/2fa/setup', async (c) => {
        const b = await body(c)
        const user = who(b.pending, 'setup')
        if (!user) return expired(c)
        return c.json(twoFactor.beginSetup(user.id, user.username, host(c)))
      })

      app.post('/api/auth/2fa/enable', async (c) => {
        const b = await body(c)
        const user = who(b.pending, 'setup')
        if (!user) return expired(c)
        const done = await finishSetup(c, user, b.code)
        if (done instanceof Response) return done
        pending.end(b.pending as string)
        startSession(c, user)
        return c.json({ user, recoveryCodes: done.codes })
      })
    },

    /** With a session (after the session middleware). */
    routes(app: Hono<Env>) {
      const me = (c: Context<Env>) => c.get('user')
      /** Setting one up: refused under `disabled` to whoever has none (whoever has one may replace it). */
      const offered = (c: Context<Env>) => (settings.twoFactorPolicy() === 'disabled' && !twoFactor.enabled(me(c).id)
        ? fail(c, 409, 'two_factor_disabled', 'the admin turned the second factor off for new setups')
        : null)

      /** Their password, counted as a sign-in's: null if right, the response otherwise. */
      const withPassword = (c: Context<Env>, u: User, password: unknown) =>
        attempt(c, u.username, u.username, async () => (typeof password === 'string' && (await auth.checkPassword(u.id, password)) ? null : 'wrong_password'), 403)
      /**
       * A code of their second factor (the app's, or a recovery code, which is
       * spent), counted as the second step's: null if right, the response
       * otherwise; none given, what is asked for.
       */
      const withCode = async (c: Context<Env>, u: User, code: unknown) => {
        if (typeof code !== 'string' || !code.trim()) {
          return c.json({ error: 'confirmation_required', message: 'confirm with a code of the second factor: the app\'s, or a recovery code', with: 'code' }, 400)
        }
        return attempt(c, secondFactorAccount(u.username), u.username, () => checkCode(u.id, code, true), 403)
      }

      app.get('/api/account/2fa', (c) => {
        const u = me(c)
        return c.json({ policy: settings.twoFactorPolicy(), ...twoFactor.status(u.id), confirmWith: inForce(u.id) ? 'code' : 'password' })
      })

      // Setting it up asks for the password: a session left open must not be
      // able to lock its owner out. Replacing the authenticator asks for a
      // code of the second factor in force (the app's, or a recovery code,
      // spent), never the password, which a session left open may know too.
      // Without phone or codes, the admin's reset is the way back.
      app.post('/api/account/2fa/setup', async (c) => {
        const off = offered(c)
        if (off) return off
        const u = me(c)
        const b = await body(c)
        const refused = inForce(u.id) ? await withCode(c, u, b.code) : await withPassword(c, u, b.password)
        if (refused) return refused
        return c.json(twoFactor.beginSetup(u.id, u.username, host(c)))
      })

      app.post('/api/account/2fa/enable', async (c) => {
        const off = offered(c)
        if (off) return off
        const done = await finishSetup(c, me(c), (await body(c)).code)
        if (done instanceof Response) return done
        return c.json({ recoveryCodes: done.codes })
      })

      // New recovery codes: a code of the second factor (the app's, or a
      // recovery code, spent), never the password.
      app.post('/api/account/2fa/recovery', async (c) => {
        const u = me(c)
        if (!inForce(u.id)) return fail(c, 409, 'two_factor_off', 'no second factor in force')
        const refused = await withCode(c, u, (await body(c)).confirm)
        if (refused) return refused
        return c.json({ recoveryCodes: await twoFactor.regenerate(u.id) })
      })

      app.post('/api/account/2fa/disable', async (c) => {
        const u = me(c)
        if (settings.twoFactorPolicy() === 'required') return fail(c, 409, 'two_factor_required', 'the admin requires a second factor')
        if (!inForce(u.id)) return fail(c, 409, 'two_factor_off', 'no second factor in force')
        const { code } = await body(c)
        const refused = await attempt(c, secondFactorAccount(u.username), u.username, () => checkCode(u.id, code, true), 403)
        if (refused) return refused
        twoFactor.disable(u.id)
        return c.json({ ok: true })
      })

      // Confirmed at the moment, and told to the person and the other admins
      // (an admin never does it unseen). Someone without one: nothing to take away, nothing asked.
      app.post('/api/admin/users/:id/2fa/reset', async (c) => {
        if (c.get('access').isAgent || me(c).role !== 'admin') return fail(c, 403, 'forbidden', 'admins only')
        const id = c.req.param('id') ?? ''
        if (!deps.users.get(id)) return fail(c, 404, 'not_found', 'no such user')
        if (twoFactor.enabled(id)) {
          const refused = await confirmIdentity(c, (await body(c)).confirm)
          if (refused) return refused
          if (twoFactor.disable(id)) deps.notices?.accountChanged(id, me(c).id, 'two_factor_reset')
        }
        return c.json({ user: deps.users.get(id) })
      })
    },
  }
}
