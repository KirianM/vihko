// The trash (the UI's, with a session: a key gets 404, as for any route of
// the web UI). Each person sees what was deleted where they may edit now,
// since they could read there (scoped.ts `trash`), and the shared spaces
// deleted whole that they may restore (spaceService.ts `deletedSpaces`):
//
//   GET    /api/trash                    { entries, spaces, bytes, retentionDays }
//            entries: [{ id, path, deletedAt, actor, deletedBy, etag?, kind?, files?, space, bytes,
//                        canRestore, canDelete, expiresAt, deletedSpace? }]
//            spaces:  [{ id, path, name, by, deletedAt, entries, bytes, canRestore, canDelete, expiresAt }]
//   POST   /api/trash/:id/restore        { to? } → { path, etag, files, left }
//   DELETE /api/trash/:id                { confirm } → { entries, bytes }: one entry, for good
//   POST   /api/trash/empty              { space?, dryRun?, confirm } → { entries, spaces, bytes, kept }
//   DELETE /api/spaces/deleted/:id       { confirm } → { entries, bytes }: a deleted space, for good
//
// Sizes are of what the person sees: an entry's note and the files of it
// they see; a deleted space's, only to who managed it (the admin restores
// one without reading it, and learns nothing of its size). Deleting for good
// is for whoever manages where it was (a shared space's managers), a
// personal space's owner, and who managed a deleted space; it's checked
// before anything is asked, then confirmed at the moment, as the admin's
// actions are (within the confirmation's window, nothing is asked).
// `expiresAt`: when the admin's retention takes it (it goes at the weekly
// run after that), null while it's off.
import type { Context, Hono } from 'hono'
import type { Access } from '../access.ts'
import type { Actor } from '../actor.ts'
import type { AdminSettings } from '../adminSettings.ts'
import type { User } from '../auth.ts'
import type { ScopedNotes, TrashListing } from '../scoped.ts'
import type { SpaceService } from '../spaceService.ts'
import { jsonBody } from './jsonBody.ts'
import { RequestError } from '../scoped.ts'

type Env = { Variables: { user: User; token: string; access: Access } }

const DAY_MS = 86_400_000

export interface TrashRoutesDeps {
  scoped: (c: Context<Env>) => ScopedNotes
  spaces: SpaceService
  settings: AdminSettings
  /** A user's current name, and a key's. */
  userName: (id: string) => string
  keyName: (id: string) => string | null
  /** The confirmation at the moment (http/twoFactor.ts `confirmIdentity`): null if confirmed, the response otherwise. */
  confirm: (c: Context<Env>, confirm: unknown) => Promise<Response | null>
}

/** Who deleted an entry, by their name now: a person, an agent (its key's name, and whose it is) or vihko. */
export type DeletedBy =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'agent'; id: string; name: string; onBehalfOf: { id: string; name: string } }
  | { kind: 'system'; name: string }

export function trashRoutes(app: Hono<Env>, deps: TrashRoutesDeps) {
  const { spaces, settings } = deps
  const body = async (c: Context<Env>): Promise<Record<string, unknown>> => {
    const b = await jsonBody<unknown>(c).catch(() => ({}))
    return typeof b === 'object' && b !== null && !Array.isArray(b) ? b as Record<string, unknown> : {}
  }
  const deletedBy = (a: Actor): DeletedBy => {
    if (a.kind === 'user') return { kind: 'user', id: a.id, name: deps.userName(a.id) }
    if (a.kind === 'agent') return { kind: 'agent', id: a.id, name: deps.keyName(a.id) ?? a.id, onBehalfOf: { id: a.onBehalfOf, name: deps.userName(a.onBehalfOf) } }
    return { kind: 'system', name: 'vihko' }
  }
  const expiresAt = (deletedAt: string) => {
    const days = settings.view().trashRetentionDays
    const at = Date.parse(deletedAt)
    return days === null || !Number.isFinite(at) ? null : new Date(at + days * DAY_MS).toISOString()
  }

  /** The trash as this person sees it: its entries, the deleted spaces they may restore, and what all of it takes. */
  const view = (c: Context<Env>) => {
    const access = c.get('access')
    const entries = deps.scoped(c).trashListing()
    // An agent never gets here (a session's route); the spaces are a person's.
    const deleted = access.isAgent ? [] : spaces.trashSpaces(access)
    const spaceOf = new Map(deleted.flatMap((d) => d.entryIds.map((e) => [e, d.id] as const)))
    const bytesOf = new Map(entries.map((e) => [e.id, e.bytes]))
    return {
      entries: entries.map((e) => ({
        ...e,
        deletedBy: deletedBy(e.actor),
        canRestore: true,
        expiresAt: expiresAt(e.deletedAt),
        // Part of a deleted space this person sees whole: restored with it, or on its own somewhere else (`to`).
        ...(spaceOf.has(e.id) ? { deletedSpace: spaceOf.get(e.id)! } : {}),
      })),
      spaces: deleted.map(({ entryIds, canDelete, ...d }) => ({
        ...d,
        // Its size only to who managed it, who sees every one of its entries.
        bytes: canDelete ? entryIds.reduce((n, id) => n + (bytesOf.get(id) ?? 0), 0) : null,
        canRestore: true,
        canDelete,
        expiresAt: expiresAt(d.deletedAt),
      })),
      bytes: entries.reduce((n, e) => n + e.bytes, 0),
      retentionDays: settings.view().trashRetentionDays,
    }
  }

  app.get('/api/trash', (c) => c.json(view(c)))

  app.post('/api/trash/:id/restore', async (c) => {
    const { to } = await body(c)
    if (to !== undefined && typeof to !== 'string') throw new RequestError(400, 'invalid', 'expected `to` as a note\'s path')
    return c.json(await deps.scoped(c).restoreTrash(c.req.param('id'), to))
  })

  const sum = (list: readonly TrashListing[]) => ({ entries: list.length, bytes: list.reduce((n, e) => n + e.bytes, 0) })

  app.delete('/api/trash/:id', async (c) => {
    const id = c.req.param('id')
    const s = deps.scoped(c)
    // Checked first: a code isn't spent on what would be refused.
    s.discardable([id])
    const refused = await deps.confirm(c, (await body(c)).confirm)
    if (refused) return refused
    return c.json(sum(s.discardTrash([id])))
  })

  /**
   * Everything in the trash this person may delete for good (in one space,
   * with `space`: its root): the entries and the deleted spaces; `kept`,
   * how many they see but may only restore. With `dryRun`, what it would
   * delete, asking nothing.
   */
  app.post('/api/trash/empty', async (c) => {
    const b = await body(c)
    if (b.space !== undefined && typeof b.space !== 'string') throw new RequestError(400, 'invalid', 'expected `space` as a space\'s root')
    const t = view(c)
    const inSpace = (root: string | null) => b.space === undefined || root === b.space
    // A deleted space's entries go with it, as one.
    const spaceIds = t.spaces.filter((d) => d.canDelete && inSpace(d.path)).map((d) => d.id)
    const alone = t.entries.filter((e) => e.deletedSpace === undefined && inSpace(e.space))
    const ids = alone.filter((e) => e.canDelete).map((e) => e.id)
    const kept = alone.filter((e) => !e.canDelete).length + t.spaces.filter((d) => !d.canDelete && inSpace(d.path)).length
    const bytes = t.entries.filter((e) => ids.includes(e.id) || (e.deletedSpace !== undefined && spaceIds.includes(e.deletedSpace))).reduce((n, e) => n + e.bytes, 0)
    const plan = { entries: ids.length, spaces: spaceIds.length, bytes, kept }
    if (b.dryRun === true || (ids.length === 0 && spaceIds.length === 0)) return c.json(plan)
    const access = c.get('access')
    const s = deps.scoped(c)
    s.discardable(ids)
    for (const id of spaceIds) spaces.discardSpace(access, id, { dryRun: true })
    const refused = await deps.confirm(c, b.confirm)
    if (refused) return refused
    s.discardTrash(ids)
    for (const id of spaceIds) spaces.discardSpace(access, id)
    return c.json(plan)
  })

  app.delete('/api/spaces/deleted/:id', async (c) => {
    const access = c.get('access')
    const id = c.req.param('id')
    const listed = view(c)
    spaces.discardSpace(access, id, { dryRun: true })
    const refused = await deps.confirm(c, (await body(c)).confirm)
    if (refused) return refused
    const { entries } = spaces.discardSpace(access, id)
    const bytes = listed.entries.filter((e) => entries.includes(e.id)).reduce((n, e) => n + e.bytes, 0)
    return c.json({ entries: entries.length, bytes })
  })
}
