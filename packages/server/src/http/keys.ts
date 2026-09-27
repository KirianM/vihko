// Agent keys and the integration switches, for the UI (session only: a key
// never reaches these, http/routes.ts).
//
//   GET    /api/integrations            the switches, the lock, whether this user may create keys, and the public URL (OAuth)
//   PUT    /api/admin/integrations      { api?, mcp?, membersCanCreateKeys?, oauthRegistration? }   the thoth admin only
//   GET    /api/keys[?all=1]            this user's keys; with all=1, the admin gets everyone's
//   POST   /api/keys                    { name, canWrite?, folders?, expiresAt?, confirm } → { key, token } (the token, once).
//                                        `confirm`: the current TOTP code, or the password without a second factor (D-036)
//   PATCH  /api/keys/:id                { name?, canWrite?, folders?, expiresAt? } its owner
//   POST   /api/keys/:id/rotate         { confirm } → { key, token }: a new secret (once); the old one works 10 more minutes. Its owner
//   DELETE /api/keys/:id                revokes it: its owner or the admin
import type { Context, Hono } from 'hono'
import type { User } from '../auth.ts'
import type { Access } from '../access.ts'
import { KeyError, type ApiKeys, type KeyInput } from '../keys.ts'
import type { Integrations } from '../integrations.ts'

type Env = { Variables: { user: User; token: string; access: Access } }

export interface KeyRoutesDeps {
  keys: ApiKeys
  integrations: Integrations
  /** THOTH_PUBLIC_URL, if set: OAuth is offered there while the MCP server is on. */
  publicUrl?: string | null
  /**
   * Confirms that the person is there now (the current TOTP code, or the
   * password without one, D-036): null if so, the response otherwise.
   */
  confirm: (c: Context<Env>, confirm: unknown) => Promise<Response | null>
}

export function keyRoutes(app: Hono<Env>, deps: KeyRoutesDeps) {
  const { keys, integrations } = deps
  const isAdmin = (c: Context<Env>) => !c.get('access').isAgent && c.get('user').role === 'admin'
  /** An admin always may; a member, if the admin allows it. */
  const mayCreate = (c: Context<Env>) => isAdmin(c) || integrations.view().membersCanCreateKeys
  const body = async (c: Context<Env>) => {
    const b = await c.req.json<unknown>()
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new KeyError('invalid', 'expected an object')
    return b as Record<string, unknown>
  }

  const view = (c: Context<Env>) => ({ ...integrations.view(), canCreateKeys: mayCreate(c), publicUrl: deps.publicUrl ?? null })

  app.get('/api/integrations', (c) => c.json(view(c)))

  app.put('/api/admin/integrations', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'forbidden', message: 'admins only' }, 403)
    const b = await body(c)
    integrations.set({
      api: b.api as boolean | undefined, mcp: b.mcp as boolean | undefined,
      membersCanCreateKeys: b.membersCanCreateKeys as boolean | undefined, oauthRegistration: b.oauthRegistration as boolean | undefined,
    })
    return c.json(view(c))
  })

  app.get('/api/keys', (c) => {
    if (c.req.query('all') === '1') {
      if (!isAdmin(c)) return c.json({ error: 'forbidden', message: 'admins only' }, 403)
      return c.json({ keys: keys.listAll() })
    }
    return c.json({ keys: keys.list(c.get('user').id) })
  })

  app.post('/api/keys', async (c) => {
    if (!mayCreate(c)) return c.json({ error: 'forbidden', message: 'members may not create keys here' }, 403)
    const b = await body(c)
    const refused = await deps.confirm(c, b.confirm)
    if (refused) return refused
    const input: KeyInput = { name: b.name, canWrite: b.canWrite, folders: b.folders, expiresAt: b.expiresAt }
    return c.json(keys.create(c.get('user'), input), 201)
  })

  /** A key of this user's; someone else's doesn't exist for them. */
  const own = (c: Context<Env>) => {
    const key = keys.get(c.req.param('id') ?? '')
    if (!key || key.userId !== c.get('user').id) throw new KeyError('not_found', 'no such key')
    return key
  }

  app.patch('/api/keys/:id', async (c) => {
    const key = own(c)
    if (!mayCreate(c)) return c.json({ error: 'forbidden', message: 'members may not change keys here' }, 403)
    const b = await body(c)
    return c.json({ key: keys.update(key.id, { name: b.name, canWrite: b.canWrite, folders: b.folders, expiresAt: b.expiresAt }) })
  })

  // Only its owner: a new secret is theirs to see (the admin revokes, never rotates, someone else's).
  // A new secret is as good as a new key: it's confirmed the same way.
  app.post('/api/keys/:id/rotate', async (c) => {
    const key = own(c)
    if (!mayCreate(c)) return c.json({ error: 'forbidden', message: 'members may not change keys here' }, 403)
    const b = await c.req.json<{ confirm?: unknown }>().catch(() => ({}) as { confirm?: unknown })
    const refused = await deps.confirm(c, b?.confirm)
    if (refused) return refused
    return c.json(keys.rotate(key.id))
  })

  app.delete('/api/keys/:id', (c) => {
    const key = isAdmin(c) ? keys.get(c.req.param('id') ?? '') : own(c)
    if (!key) throw new KeyError('not_found', 'no such key')
    return c.json({ key: keys.revoke(key.id) })
  })
}

/** HTTP status for each key error code. */
export function keyErrorStatus(e: KeyError) {
  return ({ invalid: 400, invalid_path: 400, not_found: 404, forbidden: 403 } as const)[e.code]
}
