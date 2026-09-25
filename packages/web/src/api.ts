// Cliente de la API de thoth. Sesión por cookie (HttpOnly): el navegador la envía sola.
import type { Alert } from '@thoth/core/codes'

export type { Alert }

export class ApiError extends Error {
  readonly status: number
  /** Código de error del servidor (`not_found`, `precondition_failed`…) o `network`. */
  readonly code: string
  readonly etag: string | null
  constructor(status: number, code: string, message: string, etag: string | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.etag = etag
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', 'network')
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    throw new ApiError(res.status, String(data?.error ?? 'internal'), String(data?.message ?? res.statusText), (data?.etag as string | null) ?? null)
  }
  return data as T
}

export interface User { id: string; username: string; role: 'admin' | 'member' }
export interface TreeNote { path: string; title: string; uid: string | null }
export interface Note { path: string; text: string; etag: string; meta: { title: string; uid: string | null; fm_error: string | null } | null }

export interface OutgoingLink {
  raw: string
  kind: 'wiki' | 'embed' | 'md'
  status: 'resolved' | 'ambiguous' | 'missing'
  dst_path: string | null
  candidates: string[] | null
}
export interface Backlink { path: string; title: string; raw: string; context: string }
export interface SearchResult { path: string; title: string; snippet: string }
/** Resultados de búsqueda; el resaltado del fragmento va entre caracteres de control, no en HTML. */
export interface SearchResponse { results: SearchResult[]; highlight?: { start: string; end: string } }

/** What a rename or move does (or would do, with `dryRun`). */
export interface MoveReport {
  from: string
  to: string
  relinked: { path: string; links: number; changes: { before: string; after: string }[] }[]
  kept: { path: string; raw: string; via: 'path' | 'alias' }[]
  failed: { path: string; reason: string }[]
  aliasAdded: string | null
  dryRun: boolean
}
export interface TrashEntry { id: string; path: string; deletedAt: string }

export const api = {
  setupNeeded: () => request<{ needed: boolean }>('GET', '/api/setup'),
  setup: (token: string, username: string, password: string) => request<{ user: User }>('POST', '/api/setup', { token, username, password }),
  login: (username: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  tree: () => request<{ notes: TreeNote[] }>('GET', '/api/tree'),
  note: (path: string) => request<Note>('GET', `/api/note?path=${encodeURIComponent(path)}`),
  alerts: () => request<{ alerts: Alert[] }>('GET', '/api/alerts').then((r) => r.alerts),
  conflict: (path: string) => request<{ path: string; text: string }>('GET', `/api/conflict?path=${encodeURIComponent(path)}`),
  rescan: (confirmRemoval?: number) => request<{ aborted: string | null }>('POST', '/api/admin/rescan', confirmRemoval === undefined ? {} : { confirmRemoval }),
  links: (path: string) => request<{ outgoing: OutgoingLink[]; backlinks: Backlink[] }>('GET', `/api/note/links?path=${encodeURIComponent(path)}`),
  search: (q: string) => request<SearchResponse>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  createNote: (path: string, text: string) => request<{ path: string; etag: string; uid: string | null }>('POST', '/api/note', { path, text }),
  orphan: (path: string, action: 'restore' | 'discard') => request<{ ok: true }>('POST', '/api/note/orphan', { path, action }),
  move: (from: string, to: string, dryRun = false) => request<MoveReport>('POST', '/api/note/move', { from, to, dryRun }),
  trash: (path: string) => request<TrashEntry>('DELETE', `/api/note?path=${encodeURIComponent(path)}`),
  restore: (id: string) => request<{ path: string; etag: string }>('POST', `/api/trash/${encodeURIComponent(id)}/restore`),
}
