// Which /api routes a key may call (D-035, m3 §4). It isn't a separate API:
// the same routes the UI uses, accepted with `Authorization: Bearer` only if
// listed here as `read` or `write`. Every route is classified; one that isn't
// fails closed (a key gets 404, as for a route that doesn't exist), and a test
// walks the app's routes so a new one can't go unclassified.
//
// - `read`: any key.
// - `write`: a key with `canWrite` (a read-only key gets 403).
// - `session`: the UI only, with its cookie: administration, profile,
//   session, keys, switches, alerts, trash, folders, move jobs…
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
