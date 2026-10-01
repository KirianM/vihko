// The permissions API (sharing a folder), for the share
// dialog. Session only (http/routes.ts): a key never reaches it.
//
//   GET /api/permissions?folder=           the folder's own grants, those it inherits (each with where from), its owner, agents, and who has access
//   PUT /api/permissions                   { folder, grants?, ai?, ifMatch } → the same, after writing vihko.yaml (412 if it changed)
//   GET /api/permissions/folders           the folders whoever asks sees, with their marks (shared, closed to agents)
//   GET /api/permissions/access?user=|key= the folders a person or a key reaches, and at what level
//   POST /api/permissions/holds/:id        { action: 'release' } notes held after an external move (permissionHolds.ts)
//
// Who: whoever has `manage` in the folder. The admin
// role counts for nothing (the admin manages, but doesn't read): the admin never sees the names
// of folders inside spaces they don't read. Others: 403 if they see the
// folder, 404 if not. A personal space's root can't be shared whole (only
// `ai: false` there); a folder in no space doesn't exist for anyone.
import type { Context, Hono } from 'hono'
import {
  LEVELS, WORKSPACE_FILE, atLeast, isSubject, parentFolder, parseSpacePath, rulesOf, spaceKeyProblem, subjectKey, trimSlashes,
  type Level, type RuleValue,
} from '@vihko/core'
import { AccessError, inFolders, type Access, type AccessPolicy } from '../access.ts'
import type { User } from '../auth.ts'
import type { Db } from '../db.ts'
import type { ApiKeys } from '../keys.ts'
import { NoteError } from '../notes.ts'
import { holdAccess, type PermissionHolds } from '../permissionHolds.ts'
import type { PermissionsEngine } from '../permissions.ts'
import type { PermissionsFile } from '../permissionsFile.ts'
import { RequestError } from '../scoped.ts'

type Env = { Variables: { user: User; token: string; access: Access } }

export interface PermissionRoutesDeps {
  engine: PermissionsEngine
  file: PermissionsFile
  index: Db
  keys: ApiKeys
  policy: AccessPolicy
  holds?: PermissionHolds
}

/** A folder named in a request: a real folder from the notes root (`""` is the root, which is nobody's). */
function folderParam(raw: unknown): string {
  if (typeof raw !== 'string') throw new RequestError(400, 'invalid', 'folder must be a folder path')
  const f = trimSlashes(raw.normalize('NFC'))
  if (f !== '' && (/[\\\u0000-\u001f]/.test(f) || !f.split('/').every((s) => s !== '' && !s.startsWith('.') && s !== '..' && s.trim() === s))) {
    throw new NoteError('invalid_path', `invalid folder path: ${raw}`)
  }
  return f
}

export function permissionRoutes(app: Hono<Env>, deps: PermissionRoutesDeps) {
  const { engine, file } = deps

  /** Unless whoever asks manages the folder: `forbidden` if they see it, `not_found` if not (outside every space: nobody sees it). */
  const assertManage = (c: Context<Env>, folder: string) => {
    const access = c.get('access')
    if (access.canManage(folder)) return
    if (access.level(folder) !== null) throw new AccessError('only whoever manages this folder sees and changes who it is shared with')
    throw new NoteError('not_found', `no such folder: ${folder}`)
  }

  /** The folder's grants and who has access, as the share dialog shows it. */
  const view = (c: Context<Env>, folder: string) => {
    const rules = engine.spaceRules()
    const own = rules.own(folder)
    const s = parseSpacePath(folder)!
    // Every folder above it in its space with grants of its own: they reach it too (they only add).
    const inherited: { from: string; grants: Record<string, Level> }[] = []
    for (let d = parentFolder(folder); d !== null && d.length >= s.space.root.length; d = parentFolder(d)) {
      const r = rules.own(d)
      if (r?.grants && Object.keys(r.grants).length) inherited.unshift({ from: d, grants: r.grants })
    }
    const aiAt = rules.aiClosedAt(folder)
    return {
      folder,
      /** The ETag of vihko.yaml: a change must name it (412 if the file changed). */
      etag: file.read().etag,
      /** `none`: the file has no section yet (nothing is shared; the first change writes it); `closed`: rejected, nothing is shared until it's fixed. */
      section: engine.section.kind,
      /** The grants written for this folder (null: none). */
      own: { grants: own?.grants ?? null },
      /** The grants of the folders above it in its space, from the space's root down: they apply here too, and can't be taken away here. */
      inherited,
      /** Whose personal space it is in (they manage all of it); null in a shared space. */
      owner: s.space.kind === 'personal' ? s.space.owner : null,
      /** The shared space it is in: its root and name; null in a personal space. */
      space: s.space.kind === 'shared' ? { path: s.space.root, name: engine.spaceName(s.space.root) } : null,
      /** Closed to agents (`ai: false`), and where that's set: here, or above (then it can't be undone here). */
      ai: { closed: aiAt !== null, from: aiAt },
      canEdit: c.get('access').canManage(folder),
      /** Who has access and why (effective access). */
      access: engine.audience(folder),
    }
  }

  app.get('/api/permissions', (c) => {
    const folder = folderParam(c.req.query('folder') ?? '')
    assertManage(c, folder)
    return c.json(view(c, folder))
  })

  app.put('/api/permissions', async (c) => {
    const body = await c.req.json<{ folder?: unknown; grants?: unknown; ai?: unknown; ifMatch?: unknown }>()
    const folder = folderParam(body?.folder)
    assertManage(c, folder)
    const written = engine.spaceRules().own(folder)
    let grants: Record<string, Level> | null = written?.grants ?? null
    if (body.grants !== undefined) {
      if (body.grants === null) grants = null
      else if (typeof body.grants !== 'object' || Array.isArray(body.grants)) throw new RequestError(400, 'invalid', 'grants must be a map of subject → level, or null for none')
      else {
        grants = {}
        for (const [subject, level] of Object.entries(body.grants as Record<string, unknown>)) {
          const s = subject.normalize('NFC')
          if (!isSubject(s)) throw new RequestError(400, 'invalid', `not a subject: ${subject}`)
          if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) throw new RequestError(400, 'invalid', `level must be one of ${LEVELS.join(', ')}`)
          if (Object.keys(grants).some((k) => subjectKey(k) === subjectKey(s))) throw new RequestError(400, 'invalid', `${subject} is given twice`)
          grants[s] = level as Level
        }
      }
    }
    // A personal space isn't shared whole: that's a shared space.
    if (spaceKeyProblem(folder, { grants }) === 'personal_root_grants') throw new RequestError(400, 'invalid', 'a personal space is not shared whole: share a folder in it')
    let ai: false | null = written?.ai ?? null
    if (body.ai !== undefined) {
      if (body.ai !== false && body.ai !== null) throw new RequestError(400, 'invalid', 'ai must be false (closed to agents) or null')
      ai = body.ai as false | null
    }
    const ifMatch = typeof body.ifMatch === 'string' ? body.ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '') : undefined
    if (ifMatch === undefined) throw new RequestError(428, 'precondition_required', 'ifMatch: the ETag of vihko.yaml the change was planned on')
    // A name rc.1 or rc.2 wrote at a shared space's root stays, for the start that renames its folder to it.
    const value: RuleValue = { grants, ai, name: written?.name ?? null }
    await file.setRule(folder, value, { actor: c.get('access').actor, ifMatch })
    // The dialog after the change: whoever made it may have given their own `manage` away.
    const now = deps.policy.for({ kind: 'user', user: c.get('user') })
    c.set('access', now)
    if (!now.canManage(folder)) return c.json({ folder, etag: file.read().etag, canEdit: false })
    return c.json(view(c, folder))
  })

  // The folders whoever asks sees, with their marks: whether they have grants
  // of their own (shared) and whether they're closed to agents.
  app.get('/api/permissions/folders', (c) => {
    const access = c.get('access')
    const rules = engine.spaceRules()
    const all = (deps.index.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)
    const folders = all.filter((f) => access.level(f) !== null).map((f) => {
      const own = rules.own(f)
      return {
        path: f,
        level: access.level(f),
        /** It has grants of its own: the «shared» mark in the tree. */
        ownGrants: own !== null && own.grants !== null && Object.keys(own.grants).length > 0,
        /** Closed to agents, here or above. */
        aiClosed: rules.aiClosedAt(f) !== null,
        canEdit: access.canManage(f),
      }
    })
    return c.json({ folders, section: engine.section.kind })
  })

  // What a person or a key reaches, folder by folder (effective
  // access per person or key): a person, their own and their keys'. The
  // admin, anyone's, but only among the folders the admin reads too: the
  // names of folders in spaces the admin doesn't read are never shown.
  app.get('/api/permissions/access', (c) => {
    const me = c.get('user')
    const access = c.get('access')
    const admin = !access.isAgent && me.role === 'admin'
    const userId = c.req.query('user')
    const keyId = c.req.query('key')
    const key = keyId ? deps.keys.get(keyId) : null
    if (keyId && (!key || (key.userId !== me.id && !admin))) throw new NoteError('not_found', 'no such key')
    const subjectId = key ? key.userId : userId ?? me.id
    if (subjectId !== me.id && !admin) throw new AccessError('only the admin sees another person\'s access')
    const who = engine.directory.users().find((u) => u.id === subjectId)
    if (!who) throw new NoteError('not_found', 'no such user')
    const viewer = engine.viewer(who)
    const all = (deps.index.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)
    const folders = all.flatMap((f) => {
      if (subjectId !== me.id && access.level(f) === null) return []
      let level = viewer.level(f)
      if (level === null) return []
      if (key) {
        if (key.status !== 'active' || viewer.aiClosed(f) || !inFolders(f, key.folders)) return []
        // A key reads, or writes where its user edits; it never comments alone or manages.
        level = key.canWrite && atLeast(level, 'edit') ? 'edit' : 'read'
      }
      return [{ folder: f, level }]
    })
    return c.json({ user: { id: who.id, username: who.username }, key: key ? { id: key.id, name: key.name } : null, folders })
  })

  // Notes held after a move made outside vihko (permissionHolds.ts): only
  // whoever could have made that move from vihko (`edit` where the notes
  // were and where they are) sees the hold and releases it; for anyone else
  // it doesn't exist.
  app.post('/api/permissions/holds/:id', async (c) => {
    const { action } = await c.req.json<{ action?: unknown }>().catch(() => ({ action: undefined }))
    const hold = deps.holds?.get(c.req.param('id'))
    const access = c.get('access')
    if (!hold || access.isAgent || !holdAccess(hold, { level: (f) => access.level(f) }).decides) throw new NoteError('not_found', 'no such hold')
    if (action === 'release') { deps.holds!.release(hold.id); return c.json({ ok: true }) }
    throw new RequestError(400, 'invalid', 'action must be release')
  })
}

/** For the alerts: rules written for folders that don't exist (a folder moved or deleted outside vihko, or not seen yet on NFS). */
export function rulesWithoutFolder(engine: PermissionsEngine, index: Db): string[] {
  const exists = index.prepare('select 1 from folders where path = ?')
  const notesUnder = index.prepare("select 1 from notes where path like ? escape '\\' limit 1")
  return rulesOf(engine.section).map((r) => r.folder)
    .filter((f) => f !== WORKSPACE_FILE && exists.get(f) === undefined)
    // Nor one where notes are, with no folder row yet (indexed in a moment).
    .filter((f) => notesUnder.get(f.replace(/[\\%_]/g, (x) => '\\' + x) + '/%') === undefined)
}
