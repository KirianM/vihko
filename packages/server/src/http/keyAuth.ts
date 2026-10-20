// Authentication with an agent key (`Authorization: Bearer vihko_…`), for
// the HTTP API (via `api`) and the MCP server (via `mcp`). The session cookie
// never authenticates either: a request with a key is judged by the key alone.
// Off (the switch in state.db, or VIHKO_INTEGRATIONS=off), there is nothing
// there: 404, as for a route that doesn't exist.
import type { AgentPrincipal } from '../access.ts'
import type { ApiKeys } from '../keys.ts'
import type { Integrations } from '../integrations.ts'

/**
 * The token of a Bearer authorization header; null without one (another
 * scheme, or none). An empty or malformed token is still a token: it fails
 * as a key, it doesn't fall back to the cookie.
 */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  // Compared by hand: `^\s*bearer(?:\s+(.*))?$` backtracks quadratically on a long run of spaces.
  const h = header.trimStart()
  if (h.slice(0, 6).toLowerCase() !== 'bearer') return null
  const rest = h.slice(6)
  if (rest !== '' && !/^\s/.test(rest)) return null
  return rest.trim()
}

export type KeyAuth =
  | { ok: true; principal: AgentPrincipal }
  /**
   * 404 `not_found`: off; 401 `unauthorized`: not a valid key (unknown,
   * revoked, expired, its user disabled); 403 `key_suspended`: a member's
   * key while the admin doesn't let members have keys.
   */
  | { ok: false; status: 404 | 401 | 403; error: 'not_found' | 'unauthorized' | 'key_suspended' }

/**
 * Who a key acts as, for the API (`api`) or the MCP server (`mcp`): the
 * switch for that door first, then the key.
 */
export function authenticateKey(deps: { keys: ApiKeys; integrations: Integrations }, token: string, via: 'api' | 'mcp'): KeyAuth {
  const on = via === 'api' ? deps.integrations.apiEnabled() : deps.integrations.mcpEnabled()
  if (!on) return { ok: false, status: 404, error: 'not_found' }
  const principal = deps.keys.authenticate(token, via)
  if (principal === 'suspended') return { ok: false, status: 403, error: 'key_suspended' }
  return principal ? { ok: true, principal } : { ok: false, status: 401, error: 'unauthorized' }
}
