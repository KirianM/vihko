// Spaces (D-056, spec §6.1; spaceService.ts).
//
// Anyone signed in, and a key (read):
//   GET    /api/spaces                     { personal: {path} | null, spaces: [{path, id, name, level, managers, aiClosed}],
//                                            shared: [{path, level, owner?, space?: {path, id, name}, pinned}], canCreate }
//   GET    /api/spaces/members?path=       { path, space: {path, name} | null, owner, members: [{username, level, via: [{subject, level, from, owner?}]}] }:
//                                            who has access to a folder one reads (D-056.27); `from` null where one doesn't read;
//                                            404 for anything one doesn't read, as for what doesn't exist
// A person (session):
//   POST   /api/spaces                     { name, members? } → 201 { space }: a new shared space, its creator managing it;
//                                            403 with the setting `spacesCreation: admins`, for a member
//   POST   /api/spaces/rename              { path, name } → { space }: `manage` at its root; the folder never changes
//   DELETE /api/spaces?path=&trash=true    `manage` at its root: what it holds to the trash (with trash=true), its rules out
//   POST   /api/spaces/leave               { path } → { path }: one's own grants there and under it go;
//                                            409 leave_via_group { group } through a group
//   POST   /api/spaces/pin                 { path, pinned } → { path, pinned }: a folder in «Shared with me»
// The vihko admin (session; the changes confirmed at the moment, D-040 3.1):
//   GET    /api/admin/spaces               { spaces: [{path, id, name, managers, members, aiClosed}], closed: [{userId, username, path}] }
//   POST   /api/admin/spaces/managers      { path, userId, confirm } → { space }: only to a space without managers
//                                            (409 space_has_managers)
//   POST   /api/admin/spaces/join          { path, level?, confirm } → { space }: the admin as a member (`read` by default)
//   GET    /api/admin/users/:id/space      { path, exists, sharedFolders, people }: before deleting someone
//   POST   /api/admin/users/:id/space      { action: transfer|convert|delete, to?, name?, members?, dryRun?, confirm }
//                                            → { plan }: a deleted person's closed space; with `deleteUser: true`, a
//                                            disabled person deleted and their space transferred or converted at once
import type { Context, Hono } from 'hono'
import type { Access } from '../access.ts'
import type { User } from '../auth.ts'
import type { SpaceService } from '../spaceService.ts'

type Env = { Variables: { user: User; token: string; access: Access } }

export interface SpaceRoutesDeps {
  spaces: SpaceService
  /** The confirmation at the moment (http/twoFactor.ts `confirmIdentity`): null if confirmed, the response otherwise. */
  confirm: (c: Context<Env>, confirm: unknown) => Promise<Response | null>
}

export function spaceRoutes(app: Hono<Env>, deps: SpaceRoutesDeps) {
  const { spaces } = deps
  const body = async (c: Context<Env>): Promise<Record<string, unknown>> => {
    const b = await c.req.json<unknown>()
    return typeof b === 'object' && b !== null && !Array.isArray(b) ? b as Record<string, unknown> : {}
  }
  const access = (c: Context<Env>) => c.get('access')

  app.get('/api/spaces', (c) => c.json(spaces.view(access(c))))

  app.get('/api/spaces/members', (c) => c.json(spaces.whoHasAccess(access(c), c.req.query('path'))))

  app.post('/api/spaces', async (c) => {
    const b = await body(c)
    return c.json({ space: await spaces.create(access(c), { name: b.name, members: b.members }) }, 201)
  })

  app.post('/api/spaces/rename', async (c) => {
    const b = await body(c)
    return c.json({ space: await spaces.rename(access(c), b.path, b.name) })
  })

  app.delete('/api/spaces', async (c) => c.json(await spaces.remove(access(c), c.req.query('path') ?? '', { trash: c.req.query('trash') === 'true' })))

  app.post('/api/spaces/leave', async (c) => c.json(await spaces.leave(access(c), (await body(c)).path)))

  app.post('/api/spaces/pin', async (c) => {
    const b = await body(c)
    return c.json(spaces.pin(access(c), b.path, b.pinned))
  })

  // --- The admin ---------------------------------------------------------------------
  // Each route checks the request before the confirmation, so a code isn't spent on one that would fail.

  app.get('/api/admin/spaces', (c) => c.json(spaces.directory(access(c))))

  app.post('/api/admin/spaces/managers', async (c) => {
    const b = await body(c)
    spaces.checkAssignManager(access(c), b.path, b.userId)
    const refused = await deps.confirm(c, b.confirm)
    if (refused) return refused
    return c.json({ space: await spaces.assignManager(access(c), b.path, b.userId) })
  })

  app.post('/api/admin/spaces/join', async (c) => {
    const b = await body(c)
    spaces.checkJoin(access(c), b.path, b.level)
    const refused = await deps.confirm(c, b.confirm)
    if (refused) return refused
    return c.json({ space: await spaces.join(access(c), b.path, b.level) })
  })

  app.get('/api/admin/users/:id/space', (c) => c.json(spaces.summary(access(c), c.req.param('id') ?? '')))

  app.post('/api/admin/users/:id/space', async (c) => {
    const b = await body(c)
    const id = c.req.param('id') ?? ''
    const input = { action: b.action, to: b.to, name: b.name, members: b.members }
    // Someone not deleted yet: deleting them and settling their space at once (D-056.28).
    if (b.deleteUser === true) {
      const plan = await spaces.personal(access(c), id, { ...input, dryRun: true }, { live: true })
      if (b.dryRun === true) return c.json({ plan })
      const refused = await deps.confirm(c, b.confirm)
      if (refused) return refused
      return c.json({ plan: await spaces.deleteAndSettle(access(c), id, input) })
    }
    const plan = await spaces.personal(access(c), id, { ...input, dryRun: true })
    if (b.dryRun === true) return c.json({ plan })
    const refused = await deps.confirm(c, b.confirm)
    if (refused) return refused
    return c.json({ plan: await spaces.personal(access(c), id, { ...input, dryRun: false }) })
  })
}
