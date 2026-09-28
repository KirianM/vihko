// The permissions API (D-038, for the permissions UI): a folder's rule, who
// has access and why, and changing it. Session only (http/routes.ts): a key
// never reaches it.
//
//   GET /api/permissions?folder=           the folder's rule: its own, inherited (with where from), a `{user}` rule, agents, and who has access
//   PUT /api/permissions                   { folder, grants?, ai?, ifMatch } → the same, after writing vihko.yaml (412 if it changed)
//   GET /api/permissions/folders           folders with their lock (own rules, closed to agents): the admin, every folder's name; others, those they see
//   GET /api/permissions/access?user=|key= the folders a person or a key reaches, and at what level
//   POST /api/permissions/holds/:id        { action: 'move_permissions' | 'release' } notes held after an external move (permissionHolds.ts)
//
// Who: the admin, for any folder (they see folders' names, never their
// notes, D-038.1), and whoever has `manage` in the folder (D-038.4), which
// whoever manages a folder above keeps whatever its own rules say (D-040
// 3.5), except in a personal folder (a `{user}` rule's) and under it, where
// nobody from above it manages. `ai: false` is set and removed with `manage`
// too. A `{user}` rule itself (its
// key, `personas/{user}`) only by the admin. Others: 403 if they see the
// folder, 404 if not.
import type { Context, Hono } from 'hono'
import {
  LEVELS, USER_SEGMENT, WORKSPACE_FILE, atLeast, grantsAt, isSubject, parentFolder, selfAndAncestors, subjectKey,
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

/** A folder named in a request: `""` is the root; a `{user}` rule's key is allowed (the admin's). */
function folderParam(raw: unknown): string {
  if (typeof raw !== 'string') throw new RequestError(400, 'invalid', 'folder must be a folder path ("" for the root)')
  const f = raw.normalize('NFC').replace(/^\/+|\/+$/g, '')
  if (f !== '' && (/[\\\u0000-\u001f]/.test(f) || !f.split('/').every((s) => s !== '' && !s.startsWith('.') && s !== '..' && s.trim() === s))) {
    throw new NoteError('invalid_path', `invalid folder path: ${raw}`)
  }
  if (f.split('/').filter((s) => s === USER_SEGMENT).length > 1) throw new NoteError('invalid_path', `invalid folder path: ${raw}`)
  return f
}

export function permissionRoutes(app: Hono<Env>, deps: PermissionRoutesDeps) {
  const { engine, file } = deps
  const isAdmin = (c: Context<Env>) => !c.get('access').isAgent && c.get('user').role === 'admin'

  /** Whether whoever asks may see (and change) this folder's rule: the admin, or `manage` in it. */
  const mayManage = (c: Context<Env>, folder: string) => {
    if (isAdmin(c)) return true
    if (folder.split('/').includes(USER_SEGMENT)) return false
    return c.get('access').canManage(folder)
  }
  /** Unless it may: `forbidden` if it sees the folder, `not_found` if not. */
  const assertManage = (c: Context<Env>, folder: string) => {
    if (mayManage(c, folder)) return
    if (!folder.includes(USER_SEGMENT) && c.get('access').level(folder) !== null) throw new AccessError('only whoever manages this folder, or the admin, sees and changes its permissions')
    throw new NoteError('not_found', `no such folder: ${folder}`)
  }

  /** The folder's rule and who has access, as the permissions dialog shows it. */
  const view = (c: Context<Env>, folder: string) => {
    const users = engine.directory.users()
    const set = engine.rules(users)
    const own = set?.own(folder) ?? null
    const parent = parentFolder(folder)
    const inheritedFrom = parent === null ? null : engine.grantsAt(parent, users)
    const effective = engine.grantsAt(folder, users)
    const aiAt = set?.aiClosedAt(folder) ?? null
    const section = engine.section
    // The `{user}` rule matching this folder, also under a literal one: what «restore» goes back to there.
    const pattern = folder.includes(USER_SEGMENT) ? null : set?.userRule(folder) ?? null
    const names = new Set(users.map((u) => subjectKey(u.username)))
    const personal = folder.includes(USER_SEGMENT) ? folder : set ? selfAndAncestors(folder).find((f) => set.personal(f)) ?? null : null
    return {
      folder,
      /** The ETag of vihko.yaml: a change must name it (412 if the file changed). */
      etag: file.read().etag,
      /** `implicit`: no section yet (every admin manages the root; the first change writes it); `closed`: rejected, nobody reads. */
      section: section.kind,
      /** The rule written for this folder (a `{user}` rule's, as written, with `user` the name it matches here). */
      own: own ? { rule: own.rule.folder, user: own.user, grants: own.rule.grants, ai: own.rule.ai === false } : null,
      /** What it would inherit without grants of its own: from which folder, resolved. */
      inherited: inheritedFrom?.governing ? { from: inheritedFrom.governing.at, rule: inheritedFrom.governing.rule.folder, grants: inheritedFrom.grants } : null,
      /** A `{user}` rule with grants matching this folder (resolved): it governs here unless a literal rule with grants does. */
      userRule: pattern && pattern.rule.grants !== null
        ? { rule: pattern.rule.folder, user: pattern.user, grants: grantsAt({ ...pattern, at: folder }, (n) => names.has(subjectKey(n))) }
        : null,
      /** The grants that apply here (resolved: `{user}` is the person's name), and the folder they're written for. */
      effective: { from: effective.governing?.at ?? null, rule: effective.governing?.rule.folder ?? null, grants: effective.grants },
      /**
       * Who manages it from above, whatever its own grants say (D-040 3.5):
       * each subject with the folder whose rule gives them `manage`. None in a
       * personal folder from above it (`personal`: the personal folder it is,
       * or is in; null if none).
       */
      managedAbove: folder.includes(USER_SEGMENT) ? [] : engine.reaching(folder, users).above,
      personal,
      /** Closed to agents (`ai: false`), and where that's set: here, or above (then it can't be undone here). */
      ai: { closed: aiAt !== null, from: aiAt },
      canEdit: mayManage(c, folder),
      /** Who has access and why (D-038, effective access per folder). */
      access: folder.includes(USER_SEGMENT) ? [] : engine.audience(folder),
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
    const perUser = folder.split('/').includes(USER_SEGMENT)
    const current = engine.rules()?.own(folder)
    // A literal rule is what the file has at this key; a {user} match elsewhere isn't this folder's own.
    const written = current && current.rule.folder === folder ? current.rule : null
    let grants: Record<string, Level> | null = written?.grants ?? null
    if (body.grants !== undefined) {
      if (body.grants === null) grants = null
      else if (typeof body.grants !== 'object' || Array.isArray(body.grants)) throw new RequestError(400, 'invalid', 'grants must be a map of subject → level, or null to inherit')
      else {
        grants = {}
        for (const [subject, level] of Object.entries(body.grants as Record<string, unknown>)) {
          const s = subject.normalize('NFC')
          if (!isSubject(s) || (s === USER_SEGMENT && !perUser)) throw new RequestError(400, 'invalid', `not a subject here: ${subject}`)
          if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) throw new RequestError(400, 'invalid', `level must be one of ${LEVELS.join(', ')}`)
          if (Object.keys(grants).some((k) => subjectKey(k) === subjectKey(s))) throw new RequestError(400, 'invalid', `${subject} is given twice`)
          grants[s] = level as Level
        }
      }
    }
    let ai: false | null = written?.ai ?? null
    if (body.ai !== undefined) {
      if (body.ai !== false && body.ai !== null) throw new RequestError(400, 'invalid', 'ai must be false (closed to agents) or null')
      ai = body.ai as false | null
    }
    const ifMatch = typeof body.ifMatch === 'string' ? body.ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '') : undefined
    if (ifMatch === undefined) throw new RequestError(428, 'precondition_required', 'ifMatch: the ETag of vihko.yaml the change was planned on')
    const value: RuleValue = { grants, ai }
    await file.setRule(folder, value, { actor: c.get('access').actor, ifMatch })
    // The dialog after the change: whoever made it may have given their own `manage` away.
    const now = deps.policy.for({ kind: 'user', user: c.get('user') })
    c.set('access', now)
    if (!mayManage(c, folder)) return c.json({ folder, etag: file.read().etag, canEdit: false })
    return c.json(view(c, folder))
  })

  // The folders whose permissions whoever asks may look at, with their locks:
  // the admin, every folder's name (D-038.1); others, the folders they see.
  app.get('/api/permissions/folders', (c) => {
    const access = c.get('access')
    const admin = isAdmin(c)
    const set = engine.rules()
    const all = ['', ...(deps.index.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)]
    const folders = all.filter((f) => admin || access.level(f) !== null).map((f) => {
      const own = set?.own(f) ?? null
      return {
        path: f,
        level: access.level(f),
        /** It has grants of its own (not inherited): the lock in the tree. */
        ownGrants: own !== null && own.rule.grants !== null,
        /** Closed to agents, here or above. */
        aiClosed: set?.aiClosedAt(f) != null,
        canEdit: admin || access.canManage(f),
      }
    })
    return c.json({ folders, section: engine.section.kind })
  })

  // What a person or a key reaches, folder by folder (D-038, effective
  // access per person or key): the admin, anyone's; a person, their own and
  // their keys'.
  app.get('/api/permissions/access', (c) => {
    const me = c.get('user')
    const userId = c.req.query('user')
    const keyId = c.req.query('key')
    const key = keyId ? deps.keys.get(keyId) : null
    if (keyId && (!key || (key.userId !== me.id && !isAdmin(c)))) throw new NoteError('not_found', 'no such key')
    const subjectId = key ? key.userId : userId ?? me.id
    if (subjectId !== me.id && !isAdmin(c)) throw new AccessError('only the admin sees another person\'s access')
    const who = engine.directory.users().find((u) => u.id === subjectId)
    if (!who) throw new NoteError('not_found', 'no such user')
    const viewer = engine.viewer(who)
    const all = ['', ...(deps.index.prepare('select path from folders order by path').all() as { path: string }[]).map((r) => r.path)]
    const folders = all.flatMap((f) => {
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

  // Notes held after a move made outside vihko (permissionHolds.ts): the admin, or whoever manages the folder the rules were written for;
  // from a personal folder, only whoever manages that one (D-046.4). Whoever isn't told of the hold is told nothing.
  app.post('/api/permissions/holds/:id', async (c) => {
    const { action } = await c.req.json<{ action?: unknown }>().catch(() => ({ action: undefined }))
    const hold = deps.holds?.get(c.req.param('id'))
    const access = c.get('access')
    const may = hold ? holdAccess(hold, { admin: isAdmin(c), canManage: (f) => access.canManage(f) }) : null
    if (!hold || !may?.sees) throw new NoteError('not_found', 'no such hold')
    if (!may.decides) throw new RequestError(403, 'hold_owner_only', 'these notes left a personal folder: only whoever manages it decides')
    if (action === 'release') { deps.holds!.release(hold.id); return c.json({ ok: true }) }
    if (action === 'move_permissions') {
      if (hold.to === null) throw new RequestError(400, 'invalid', 'where its notes went is not known: move the rules by hand')
      await file.moveRules(hold.folder, hold.to, { actor: c.get('access').actor })
      deps.holds!.release(hold.id)
      return c.json({ ok: true, etag: file.read().etag })
    }
    throw new RequestError(400, 'invalid', 'action must be move_permissions or release')
  })
}

/** For the alerts: rules written for folders that don't exist (a folder moved or deleted outside vihko). */
export function rulesWithoutFolder(engine: PermissionsEngine, index: Db): string[] {
  const section = engine.section
  if (section.kind !== 'rules') return []
  const exists = index.prepare('select 1 from folders where path = ?')
  return section.rules.map((r) => r.folder)
    .filter((f) => f !== '' && f !== WORKSPACE_FILE && !f.split('/').includes(USER_SEGMENT) && exists.get(f) === undefined)
    // Nor one where notes are, with no folder row yet (indexed in a moment).
    .filter((f) => index.prepare("select 1 from notes where path like ? escape '\\' limit 1").get(f.replace(/[\\%_]/g, (x) => '\\' + x) + '/%') === undefined)
}
