// Which /api routes a key may call. It isn't a separate API:
// the same routes the UI uses, accepted with `Authorization: Bearer` only if
// listed here as `read` or `write`. Every route is classified; one that isn't
// fails closed (a key gets 404, as for a route that doesn't exist), and a test
// walks the app's routes so a new one can't go unclassified.
//
// - `read`: any key.
// - `write`: a key with `canWrite` (a read-only key gets 403).
// - `session`: the UI only, with its cookie: administration, profile,
//   session, keys, switches, alerts, trash, folders, move jobs, OAuth consent…
// - `public`: no session at all (health, first boot, login). Never with a key.

export type RouteClass = 'read' | 'write' | 'session' | 'public'

export const ROUTES: Readonly<Record<string, RouteClass>> = {
  'GET /api/health': 'public',
  'GET /api/setup': 'public',
  'POST /api/setup': 'public',
  'POST /api/auth/login': 'public',
  'GET /api/invite/:token': 'public',
  'POST /api/invite/:token': 'public',
  'POST /api/auth/login/code': 'public',
  'POST /api/auth/2fa/setup': 'public',
  'POST /api/auth/2fa/enable': 'public',

  'GET /api/note': 'read',
  'GET /api/note/links': 'read',
  'GET /api/note/headings': 'read',
  'GET /api/note/comments': 'read',
  'GET /api/search': 'read',
  'GET /api/tree': 'read',
  'GET /api/tags': 'read',
  'GET /api/daily': 'read',
  'GET /api/file': 'read',
  'GET /api/history/status': 'read',
  'GET /api/history/versions': 'read',
  'GET /api/history/version': 'read',
  'GET /api/history/diff': 'read',
  'GET /api/history/changes': 'read',
  'GET /api/history/resolved': 'read',
  'GET /api/spaces': 'read',
  'GET /api/spaces/members': 'read',

  'POST /api/note': 'write',
  'PUT /api/note': 'write',
  'POST /api/note/edit': 'write',
  'POST /api/note/move': 'write',
  'DELETE /api/note': 'write',
  'POST /api/daily': 'write',
  'POST /api/attachments': 'write',
  'POST /api/history/restore': 'write',
  'POST /api/history/revert': 'write',

  'POST /api/auth/logout': 'session',
  'GET /api/auth/me': 'session',
  'GET /api/config': 'session',
  'GET /api/workspace': 'session',
  'GET /api/profile': 'session',
  'PUT /api/profile': 'session',
  'GET /api/home': 'session',
  'GET /api/events': 'session',
  'GET /api/settings': 'session',
  'PUT /api/settings': 'session',
  'POST /api/folder': 'session',
  'DELETE /api/folder': 'session',
  'POST /api/folder/move': 'session',
  'POST /api/folder/templates': 'session',
  'POST /api/note/template': 'session',
  'GET /api/move-jobs/:id': 'session',
  'POST /api/note/link/pin': 'session',
  'POST /api/note/comment': 'session',
  'GET /api/history/purgeable': 'session',
  'POST /api/history/purge': 'session',
  'DELETE /api/history/purges/:id': 'session',
  'POST /api/note/orphan': 'session',
  'POST /api/external-moves/:id/relink': 'session',
  'POST /api/attachments/fetch': 'session',
  'GET /api/trash': 'session',
  'POST /api/trash/:id/restore': 'session',
  'GET /api/alerts': 'session',
  'GET /api/conflict': 'session',
  'POST /api/admin/rescan': 'session',
  'DELETE /api/admin/config-migrations/:id': 'session',
  'DELETE /api/admin/state-migrations/:id': 'session',
  'POST /api/admin/permissions/restore': 'session',
  'PUT /api/admin/users/:id/username': 'session',
  'GET /api/spaces/deleted': 'session',
  'POST /api/spaces/restore': 'session',
  'DELETE /api/admin/permissions/restore': 'session',
  'POST /api/auth/password': 'session',
  'GET /api/directory': 'session',
  'GET /api/account/sessions': 'session',
  'DELETE /api/account/sessions': 'session',
  'DELETE /api/account/sessions/:id': 'session',
  'DELETE /api/account/notices/:id': 'session',
  'GET /api/admin/users': 'session',
  'POST /api/admin/users': 'session',
  'POST /api/admin/users/:id/link': 'session',
  'PUT /api/admin/users/:id/role': 'session',
  'POST /api/admin/users/:id/disable': 'session',
  'POST /api/admin/users/:id/enable': 'session',
  'DELETE /api/admin/users/:id': 'session',
  'DELETE /api/admin/users/:id/sessions': 'session',
  'GET /api/admin/groups': 'session',
  'POST /api/admin/groups': 'session',
  'PATCH /api/admin/groups/:id': 'session',
  'DELETE /api/admin/groups/:id': 'session',
  'POST /api/admin/groups/:id/members': 'session',
  'DELETE /api/admin/groups/:id/members/:userId': 'session',
  'GET /api/admin/settings': 'session',
  'PUT /api/admin/settings': 'session',
  'GET /api/admin/retention': 'session',
  'POST /api/admin/retention/preview': 'session',
  'POST /api/admin/retention/run': 'session',
  'GET /api/account/2fa': 'session',
  'POST /api/account/2fa/setup': 'session',
  'POST /api/account/2fa/enable': 'session',
  'POST /api/account/2fa/recovery': 'session',
  'POST /api/account/2fa/disable': 'session',
  'POST /api/admin/users/:id/2fa/reset': 'session',
  'GET /api/integrations': 'session',
  'PUT /api/admin/integrations': 'session',
  'GET /api/keys': 'session',
  'POST /api/keys': 'session',
  'PATCH /api/keys/:id': 'session',
  'DELETE /api/keys/:id': 'session',
  'POST /api/keys/:id/rotate': 'session',
  'GET /api/oauth/authorize': 'session',
  'POST /api/oauth/authorize': 'session',
  'GET /api/permissions': 'session',
  'PUT /api/permissions': 'session',
  'GET /api/permissions/folders': 'session',
  'GET /api/permissions/access': 'session',
  'POST /api/permissions/holds/:id': 'session',
  'POST /api/spaces': 'session',
  'POST /api/spaces/from-folder': 'session',
  'POST /api/spaces/rename': 'session',
  'DELETE /api/spaces': 'session',
  'POST /api/spaces/leave': 'session',
  'POST /api/spaces/pin': 'session',
  'GET /api/admin/spaces': 'session',
  'POST /api/admin/spaces/managers': 'session',
  'POST /api/admin/spaces/join': 'session',
  'GET /api/admin/users/:id/space': 'session',
  'POST /api/admin/users/:id/space': 'session',
}

/**
 * What each route needs of the folders' permissions, for a person
 * (a key's agent needs the same of its user, and its key's own limits). The
 * leak tests walk every route with two people and an agent over the same
 * tree; a route without its line here fails them.
 *
 * - `none`: nothing about notes (health, sign-in, the person's own profile,
 *   keys and session, the installation's switches).
 * - `admin`: the vihko admin's (users, the rescan): never notes' contents.
 * - `filtered`: lists (tree, search, tags, trash, alerts, «Recent
 *   changes»…): only what the person may see, counts included.
 * - `read`, `comment`, `edit`, `manage`: that level where the note or folder
 *   named is; below it, 403 if they see it, 404 if not.
 * - `history`: `edit` where the note is (sharing a note to read doesn't give away its past).
 * - `permissions`: the admin, or `manage` in the folder (http/permissions.ts).
 */
export type RouteNeeds = 'none' | 'admin' | 'filtered' | 'read' | 'comment' | 'edit' | 'manage' | 'history' | 'permissions'

export const ROUTE_NEEDS: Readonly<Record<string, RouteNeeds>> = {
  'GET /api/health': 'none',
  'GET /api/setup': 'none',
  'POST /api/setup': 'none',
  'POST /api/auth/login': 'none',
  'POST /api/auth/logout': 'none',
  'GET /api/auth/me': 'none',
  'GET /api/config': 'none',
  'GET /api/workspace': 'none',
  'GET /api/profile': 'none',
  'PUT /api/profile': 'none',
  // «Home»: only what the person reads now, note by note.
  'GET /api/home': 'filtered',
  // The tree, live: «read your tree again», only to whom a change concerns.
  'GET /api/events': 'filtered',
  // Note settings: one's own, or a shared space's (read by its members, changed by its managers).
  'GET /api/settings': 'filtered',
  'PUT /api/settings': 'manage',
  'GET /api/integrations': 'none',
  'PUT /api/admin/integrations': 'admin',
  'GET /api/keys': 'none',
  'POST /api/keys': 'none',
  'PATCH /api/keys/:id': 'none',
  'DELETE /api/keys/:id': 'none',
  'POST /api/keys/:id/rotate': 'none',
  'GET /api/oauth/authorize': 'none',
  'POST /api/oauth/authorize': 'none',
  'POST /api/admin/rescan': 'admin',
  'DELETE /api/admin/config-migrations/:id': 'admin',
  'DELETE /api/admin/state-migrations/:id': 'admin',
  // Deleted spaces: those one managed then (the admin, every one), and restoring one whole.
  'GET /api/spaces/deleted': 'filtered',
  'POST /api/spaces/restore': 'manage',
  // Someone invited renamed: their folder and grants to them follow.
  'PUT /api/admin/users/:id/username': 'admin',
  // vihko.yaml's permissions gone: the last ones written back, or forgotten.
  'POST /api/admin/permissions/restore': 'admin',
  'DELETE /api/admin/permissions/restore': 'admin',
  'POST /api/admin/users': 'admin',
  // One-time links, one's own account, and the names of users and groups (to share with).
  'GET /api/invite/:token': 'none',
  'POST /api/invite/:token': 'none',
  'GET /api/directory': 'none',
  'GET /api/account/sessions': 'none',
  'DELETE /api/account/sessions': 'none',
  'DELETE /api/account/sessions/:id': 'none',
  'POST /api/auth/password': 'none',
  // One's own notices (notices.ts): only one's own is dismissed; the others don't exist.
  'DELETE /api/account/notices/:id': 'none',
  'GET /api/admin/users': 'admin',
  'POST /api/admin/users/:id/link': 'admin',
  'PUT /api/admin/users/:id/role': 'admin',
  'POST /api/admin/users/:id/disable': 'admin',
  'POST /api/admin/users/:id/enable': 'admin',
  'DELETE /api/admin/users/:id': 'admin',
  'DELETE /api/admin/users/:id/sessions': 'admin',
  'GET /api/admin/groups': 'admin',
  'POST /api/admin/groups': 'admin',
  'PATCH /api/admin/groups/:id': 'admin',
  'DELETE /api/admin/groups/:id': 'admin',
  'POST /api/admin/groups/:id/members': 'admin',
  'DELETE /api/admin/groups/:id/members/:userId': 'admin',
  'GET /api/admin/settings': 'admin',
  'PUT /api/admin/settings': 'admin',
  // Retention (retention.ts): counts and dates only, never a path.
  'GET /api/admin/retention': 'admin',
  'POST /api/admin/retention/preview': 'admin',
  'POST /api/admin/retention/run': 'admin',
  // The second factor: the sign-in's second step, one's own, and the admin's reset.
  'POST /api/auth/login/code': 'none',
  'POST /api/auth/2fa/setup': 'none',
  'POST /api/auth/2fa/enable': 'none',
  'GET /api/account/2fa': 'none',
  'POST /api/account/2fa/setup': 'none',
  'POST /api/account/2fa/enable': 'none',
  'POST /api/account/2fa/recovery': 'none',
  'POST /api/account/2fa/disable': 'none',
  'POST /api/admin/users/:id/2fa/reset': 'admin',

  'GET /api/tree': 'filtered',
  'GET /api/tags': 'filtered',
  'GET /api/search': 'filtered',
  'GET /api/trash': 'filtered',
  'GET /api/alerts': 'filtered',
  'GET /api/history/status': 'none',
  'GET /api/history/changes': 'filtered',
  'GET /api/move-jobs/:id': 'filtered',

  'GET /api/note': 'read',
  'GET /api/note/links': 'read',
  'GET /api/note/headings': 'read',
  'GET /api/note/comments': 'read',
  'GET /api/daily': 'read',
  'GET /api/file': 'read',
  'GET /api/conflict': 'read',

  // A person who may comment but not edit (an agent comments by editing).
  'POST /api/note/comment': 'comment',

  'POST /api/note': 'edit',
  'PUT /api/note': 'edit',
  'POST /api/note/edit': 'edit',
  'POST /api/note/move': 'edit',
  'DELETE /api/note': 'edit',
  'POST /api/daily': 'edit',
  'POST /api/attachments': 'edit',
  'POST /api/attachments/fetch': 'edit',
  'POST /api/note/link/pin': 'edit',
  'POST /api/note/orphan': 'edit',
  'POST /api/external-moves/:id/relink': 'edit',
  'POST /api/trash/:id/restore': 'edit',
  'POST /api/folder': 'edit',
  // Templates: the mark written into notes, as any edit.
  'POST /api/folder/templates': 'edit',
  'POST /api/note/template': 'edit',

  'DELETE /api/folder': 'manage',
  'POST /api/folder/move': 'manage',

  'GET /api/history/versions': 'history',
  'GET /api/history/version': 'history',
  'GET /api/history/diff': 'history',
  'GET /api/history/resolved': 'history',
  'POST /api/history/restore': 'history',
  'POST /api/history/revert': 'history',
  // Or the vihko admin, any path by its name, without reading it.
  'GET /api/history/purgeable': 'filtered',
  'POST /api/history/purge': 'manage',
  'DELETE /api/history/purges/:id': 'admin',

  'GET /api/permissions': 'permissions',
  'PUT /api/permissions': 'permissions',
  'GET /api/permissions/folders': 'filtered',
  'GET /api/permissions/access': 'none',
  'POST /api/permissions/holds/:id': 'permissions',

  // Spaces: what the person reaches; creating one (anyone, or admins with the setting); pinning
  // what is shared with them; renaming, deleting and leaving, `manage` at a space's root or a grant of
  // one's own where one leaves; and the admin's, who names spaces (no secret) but never a folder inside one.
  'GET /api/spaces': 'filtered',
  // Who has access to a folder one reads: names and levels, nothing of folders one doesn't read.
  'GET /api/spaces/members': 'read',
  'POST /api/spaces': 'none',
  // A folder becoming a space of its own: `manage` in it and the right to create spaces.
  'POST /api/spaces/from-folder': 'manage',
  'POST /api/spaces/pin': 'filtered',
  'POST /api/spaces/rename': 'manage',
  'DELETE /api/spaces': 'manage',
  'POST /api/spaces/leave': 'read',
  'GET /api/admin/spaces': 'admin',
  'POST /api/admin/spaces/managers': 'admin',
  'POST /api/admin/spaces/join': 'admin',
  'GET /api/admin/users/:id/space': 'admin',
  'POST /api/admin/users/:id/space': 'admin',
}

/**
 * The `public` routes that answer the same with a key as without one: an
 * `Authorization` header there is ignored, never judged (a monitor or a
 * script that sends its key with every request). Every other `public` route
 * is still 404 with a key.
 */
const KEY_IGNORED: ReadonlySet<string> = new Set(['GET /api/health', 'GET /api/setup', 'POST /api/setup'])

const routeOf = (method: string, path: string) => `${method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()} ${path}`

/**
 * What a key may do with this request: `read`, `write`, `ignored` (a route
 * that needs none and ignores it), or null (not for keys, or not a route).
 * Only exact paths: no route open to keys has parameters in its path. HEAD
 * is a GET.
 */
export function keyRouteClass(method: string, path: string): 'read' | 'write' | 'ignored' | null {
  const route = routeOf(method, path)
  if (KEY_IGNORED.has(route)) return 'ignored'
  const c = ROUTES[route]
  return c === 'read' || c === 'write' ? c : null
}
