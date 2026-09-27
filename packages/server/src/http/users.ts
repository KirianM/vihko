// Users, groups, one-time links and one's own account (M4, users.ts), for
// the UI (a session; a key never reaches these, http/routes.ts).
//
// Without a session (before the session middleware):
//   GET    /api/invite/:token                  whom a link is for → { kind, username }; any link that doesn't work: 404 invalid_link
//   POST   /api/invite/:token                  { password } → signs in (cookie) → { user }
// Anyone signed in:
//   GET    /api/directory                      names of users and groups, to share with them
//   GET    /api/account/sessions               own sessions, `current` marked
//   DELETE /api/account/sessions               ends every other session of one's own
//   DELETE /api/account/sessions/:id           ends one
//   POST   /api/auth/password                  { current, password }: other sessions end
// The thoth admin:
//   GET    /api/admin/users                    everyone (state, role, groups, pending link, sessions)
//   POST   /api/admin/users                    { username, role } → { user, link }  (with `password`: no link, as before M4)
//   POST   /api/admin/users/:id/link           a new link (an invitation, or a reset if they have a password) → { link }
//   PUT    /api/admin/users/:id/role           { role }
//   POST   /api/admin/users/:id/disable | enable
//   DELETE /api/admin/users/:id                only someone disabled
//   DELETE /api/admin/users/:id/sessions       ends all their sessions
//   GET    /api/admin/groups, POST { name }, PATCH /:id { name }, DELETE /:id
//   POST   /api/admin/groups/:id/members { userId }, DELETE /api/admin/groups/:id/members/:userId
//   GET    /api/admin/settings, PUT { membersLocalDownloads? }
//
// Guessing a link (or the current password) counts in the login limits, as a
// password or the first-boot token does (loginLimit.ts).
import type { Context, Hono } from 'hono'
import { AuthError, sessionIdOf, type Auth, type User } from '../auth.ts'
import type { Access } from '../access.ts'
import type { AdminSettings } from '../adminSettings.ts'
import type { AttemptResult, LoginLimiter } from '../loginLimit.ts'
import { UsersError, type NewLink, type Users } from '../users.ts'

type Env = { Variables: { user: User; token: string; access: Access } }

/** The account the link attempts are counted under in the login limits (no username has a NUL). */
export const LINK_ACCOUNT = '\0link'

export interface UserRoutesDeps {
  auth: Auth
  users: Users
  settings: AdminSettings
  limiter: LoginLimiter
  /** The client's address, as the login limits count it. */
  ipOf: (c: Context) => string
  /** The login limits' device for this username, from the request's cookie. */
  deviceOf: (c: Context, username: string) => string | null
  /** Sets the session cookie (and the device's) of a user who just signed in. */
  signedIn: (c: Context, username: string, session: { token: string; expiresAt: Date }) => void
  tooMany: (c: Context, retryAfter: number) => Response
  /** THOTH_PUBLIC_URL, if set: the address the links are given for. */
  publicUrl: string | null
}

const fail = (c: Context, status: 400 | 403 | 404, error: string, message: string) => c.json({ error, message }, status)

/** The routes a one-time link is used through: before the session middleware. */
export function inviteRoutes(app: Hono<Env>, deps: UserRoutesDeps) {
  const { users, limiter } = deps
  /** Counted as a guess until the link turns out to work. */
  const attempt = (c: Context): AttemptResult => limiter.begin({ ip: deps.ipOf(c), account: LINK_ACCOUNT })
  const refused = (c: Context, a: Extract<AttemptResult, { ok: true }>) => {
    const wait = a.failed()
    if (wait > 0) return deps.tooMany(c, wait)
    return fail(c, 404, 'invalid_link', 'this link is not valid (unknown, used or expired)')
  }

  app.get('/api/invite/:token', (c) => {
    const a = attempt(c)
    if (!a.ok) return deps.tooMany(c, a.retryAfter)
    const link = users.link(c.req.param('token'))
    if (!link) return refused(c, a)
    a.passed()
    return c.json({ kind: link.kind, username: link.username })
  })

  app.post('/api/invite/:token', async (c) => {
    const { password } = await c.req.json<{ password?: unknown }>()
    const a = attempt(c)
    if (!a.ok) return deps.tooMany(c, a.retryAfter)
    const token = c.req.param('token')
    if (!users.link(token)) return refused(c, a)
    a.passed()
    const user = await users.accept(token, password)
    deps.signedIn(c, user.username, deps.auth.startSession(user.id, c.req.header('user-agent')))
    return c.json({ user })
  })
}

/** The routes with a session (after the session middleware). */
export function userRoutes(app: Hono<Env>, deps: UserRoutesDeps) {
  const { auth, users, settings } = deps
  const admin = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.get('access').isAgent || c.get('user').role !== 'admin') return fail(c, 403, 'forbidden', 'admins only')
    await next()
  }
  const body = async (c: Context<Env>) => {
    const b = await c.req.json<unknown>()
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new UsersError('invalid', 'expected an object')
    return b as Record<string, unknown>
  }
  const link = (l: NewLink) => {
    const path = `/invite/${l.token}`
    return { ...l, path, url: deps.publicUrl ? `${deps.publicUrl}${path}` : null }
  }
  const param = (c: Context<Env>, name: string) => c.req.param(name) ?? ''
  /** The public id of the request's session. */
  const current = (c: Context<Env>) => sessionIdOf(c.get('token'))

  app.get('/api/directory', (c) => c.json(users.directory()))

  // --- One's own account ------------------------------------------------------

  app.get('/api/account/sessions', (c) => {
    const here = current(c)
    return c.json({ sessions: auth.sessions(c.get('user').id).map((s) => ({ ...s, current: s.id === here })) })
  })

  app.delete('/api/account/sessions', (c) => {
    const me = c.get('user').id
    const keep = current(c)
    const ended = auth.endSessions(me, keep)
    users.hooks.onSessionsEnded?.(me)
    return c.json({ ended })
  })

  app.delete('/api/account/sessions/:id', (c) => {
    const me = c.get('user').id
    const id = param(c, 'id')
    if (!auth.endSession(me, id)) return fail(c, 404, 'not_found', 'no such session')
    users.hooks.onSessionsEnded?.(me)
    return c.json({ ok: true })
  })

  // A new password: the current one is asked for (a session left open is not
  // enough), and every other session ends. Wrong guesses count as failed logins.
  app.post('/api/auth/password', async (c) => {
    const b = await body(c)
    const user = c.get('user')
    const a = deps.limiter.begin({ ip: deps.ipOf(c), account: user.username, device: deps.deviceOf(c, user.username) })
    if (!a.ok) return deps.tooMany(c, a.retryAfter)
    if (typeof b.current !== 'string' || !(await auth.checkPassword(user.id, b.current))) {
      const wait = a.failed()
      return wait > 0 ? deps.tooMany(c, wait) : fail(c, 403, 'wrong_password', 'the current password is not right')
    }
    a.passed()
    if (typeof b.password !== 'string') throw new AuthError('weak_password', 'password must be text')
    await auth.setPassword(user.id, b.password)
    const keep = current(c)
    auth.endSessions(user.id, keep)
    users.hooks.onSessionsEnded?.(user.id)
    return c.json({ ok: true })
  })

  // --- Users (the thoth admin) ------------------------------------------------

  app.get('/api/admin/users', admin, (c) => c.json({ users: users.list() }))

  app.post('/api/admin/users', admin, async (c) => {
    const b = await body(c)
    // With a password, as before M4 (a script, the tests): no link.
    if (b.password !== undefined) {
      const u = await auth.createUser(String(b.username ?? ''), typeof b.password === 'string' ? b.password : '', b.role === 'admin' ? 'admin' : 'member')
      return c.json({ user: users.get(u.id) }, 201)
    }
    const r = await users.create(String(b.username ?? ''), b.role ?? 'member')
    return c.json({ user: r.user, link: link(r.link) }, 201)
  })

  app.post('/api/admin/users/:id/link', admin, (c) => c.json({ link: link(users.newLink(param(c, 'id'))), user: users.get(param(c, 'id')) }))

  app.put('/api/admin/users/:id/role', admin, async (c) => c.json({ user: users.setRole(param(c, 'id'), (await body(c)).role) }))

  app.post('/api/admin/users/:id/disable', admin, (c) => c.json({ user: users.disable(param(c, 'id')) }))

  app.post('/api/admin/users/:id/enable', admin, (c) => c.json({ user: users.enable(param(c, 'id')) }))

  app.delete('/api/admin/users/:id', admin, async (c) => {
    await users.remove(param(c, 'id'))
    return c.json({ ok: true })
  })

  app.delete('/api/admin/users/:id/sessions', admin, (c) => c.json({ ended: users.endSessions(param(c, 'id')) }))

  // --- Groups (the thoth admin) -----------------------------------------------

  app.get('/api/admin/groups', admin, (c) => c.json({ groups: users.groups() }))

  app.post('/api/admin/groups', admin, async (c) => c.json({ group: users.createGroup((await body(c)).name) }, 201))

  app.patch('/api/admin/groups/:id', admin, async (c) => c.json({ group: await users.renameGroup(param(c, 'id'), (await body(c)).name) }))

  app.delete('/api/admin/groups/:id', admin, async (c) => {
    await users.deleteGroup(param(c, 'id'))
    return c.json({ ok: true })
  })

  app.post('/api/admin/groups/:id/members', admin, async (c) => {
    const { userId } = await body(c)
    if (typeof userId !== 'string') throw new UsersError('invalid', 'userId must be a user id')
    return c.json({ group: users.addMember(param(c, 'id'), userId) })
  })

  app.delete('/api/admin/groups/:id/members/:userId', admin, (c) => c.json({ group: users.removeMember(param(c, 'id'), param(c, 'userId')) }))

  // --- Settings (the thoth admin) ---------------------------------------------

  app.get('/api/admin/settings', admin, (c) => c.json(settings.view()))

  app.put('/api/admin/settings', admin, async (c) => c.json(settings.set(await body(c))))
}

/** HTTP status for each users error code. */
export function usersErrorStatus(e: UsersError) {
  return ({ not_found: 404, last_admin: 409, not_disabled: 409, user_disabled: 409, invalid_link: 404, group_exists: 409, invalid_group_name: 400, invalid: 400 } as const)[e.code]
}
