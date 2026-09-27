// Which /api routes a key may call (D-035, m3 §4). It isn't a separate API:
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
  'POST /api/folder': 'session',
  'DELETE /api/folder': 'session',
  'POST /api/folder/move': 'session',
  'GET /api/move-jobs/:id': 'session',
  'POST /api/note/link/pin': 'session',
  'POST /api/note/orphan': 'session',
  'POST /api/external-moves/:id/relink': 'session',
  'POST /api/attachments/fetch': 'session',
  'GET /api/trash': 'session',
  'POST /api/trash/:id/restore': 'session',
  'GET /api/alerts': 'session',
  'GET /api/conflict': 'session',
  'POST /api/admin/rescan': 'session',
  'POST /api/admin/users': 'session',
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
}

/**
 * What each route needs of the folders' permissions (D-038), for a person
 * (a key's agent needs the same of its user, and its key's own limits). The
 * leak tests walk every route with two people and an agent over the same
 * tree; a route without its line here fails them.
 *
 * - `none`: nothing about notes (health, sign-in, the person's own profile,
 *   keys and session, the installation's switches).
 * - `admin`: the thoth admin's (users, the rescan): never notes' contents.
 * - `filtered`: lists (tree, search, tags, trash, alerts, «Recent
 *   changes»…): only what the person may see, counts included.
 * - `read`, `comment`, `edit`, `manage`: that level where the note or folder
 *   named is; below it, 403 if they see it, 404 if not.
 * - `history`: `edit` where the note is (D-034 3.5).
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
  'POST /api/admin/users': 'admin',

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

  'DELETE /api/folder': 'manage',
  'POST /api/folder/move': 'manage',

  'GET /api/history/versions': 'history',
  'GET /api/history/version': 'history',
  'GET /api/history/diff': 'history',
  'GET /api/history/resolved': 'history',
  'POST /api/history/restore': 'history',
  'POST /api/history/revert': 'history',

  'GET /api/permissions': 'permissions',
  'PUT /api/permissions': 'permissions',
  'GET /api/permissions/folders': 'filtered',
  'GET /api/permissions/access': 'none',
  'POST /api/permissions/holds/:id': 'permissions',
}

/**
 * What a key may do with this request: `read`, `write`, or null (not for
 * keys, or not a route). Only exact paths: no route open to keys has
 * parameters in its path. HEAD is a GET.
 */
export function keyRouteClass(method: string, path: string): 'read' | 'write' | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const c = ROUTES[`${m} ${path}`]
  return c === 'read' || c === 'write' ? c : null
}
