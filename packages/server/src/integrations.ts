// The integration switches: the HTTP API with keys, the MCP server,
// whether members may create their own keys and whether OAuth clients may
// register themselves, all off by default (closed unless someone opens them). They
// live in state.db and only the vihko admin changes them, from the UI; they
// apply at once. The server's administrator can lock them
// all off with VIHKO_INTEGRATIONS=off, whatever state.db says.
import type { Db } from './db.ts'

export interface IntegrationSettings {
  /** Requests with a key to the listed /api routes (http/routes.ts). */
  api: boolean
  /** The MCP server at /mcp. */
  mcp: boolean
  /** Members may create and change their own keys (an admin always can). Off by default. */
  membersCanCreateKeys: boolean
  /**
   * OAuth clients may register themselves (RFC 7591), when OAuth exists at
   * all (VIHKO_PUBLIC_URL and the MCP server on; oauth.ts). Off by default:
   * a client that registers itself (mcp-remote, say) needs it on; one that
   * names itself by a metadata URL (cimd.ts), as claude.ai does, doesn't.
   * Off, clients already registered keep working.
   */
  oauthRegistration: boolean
}

/** What the UI shows: the stored switches and whether the server locks them off. */
export interface IntegrationsView extends IntegrationSettings {
  /** VIHKO_INTEGRATIONS=off: the API and MCP are off whatever the switches say. */
  locked: boolean
}

const DEFAULTS: IntegrationSettings = { api: false, mcp: false, membersCanCreateKeys: false, oauthRegistration: false }

const KEYS: Record<keyof IntegrationSettings, string> = {
  api: 'integrations.api',
  mcp: 'integrations.mcp',
  membersCanCreateKeys: 'integrations.membersCanCreateKeys',
  oauthRegistration: 'integrations.oauthRegistration',
}

export class IntegrationsError extends Error {
  readonly code: 'integrations_locked' | 'invalid'
  constructor(code: IntegrationsError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export class Integrations {
  private db: Db
  readonly locked: boolean

  constructor(state: Db, opts: { locked?: boolean } = {}) {
    this.db = state
    this.locked = opts.locked ?? false
  }

  /** The stored switches (defaults for those never set), with the lock. */
  view(): IntegrationsView {
    const rows = this.db.prepare("select key, value from settings where key like 'integrations.%'").all() as { key: string; value: string }[]
    const stored = new Map(rows.map((r) => [r.key, r.value]))
    const out = { ...DEFAULTS, locked: this.locked }
    for (const k of Object.keys(KEYS) as (keyof IntegrationSettings)[]) {
      const v = stored.get(KEYS[k])
      if (v === 'true' || v === 'false') out[k] = v === 'true'
    }
    return out
  }

  /** Whether requests with a key reach the API now. */
  apiEnabled(): boolean {
    return !this.locked && this.view().api
  }

  /** Whether /mcp exists now. */
  mcpEnabled(): boolean {
    return !this.locked && this.view().mcp
  }

  /**
   * Changes some switches, all or none. With the lock, turning the API or the
   * MCP on is refused (turning them off is still stored).
   */
  set(patch: Partial<IntegrationSettings>): IntegrationsView {
    const entries = Object.entries(patch ?? {}).filter(([, v]) => v !== undefined)
    for (const [k, v] of entries) {
      if (!(k in KEYS)) throw new IntegrationsError('invalid', `unknown setting: ${k}`)
      if (typeof v !== 'boolean') throw new IntegrationsError('invalid', `${k} must be true or false`)
      if (this.locked && (k === 'api' || k === 'mcp') && v) throw new IntegrationsError('integrations_locked', 'VIHKO_INTEGRATIONS=off locks the API and MCP off')
    }
    const put = this.db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
    this.db.transaction(() => {
      for (const [k, v] of entries) put.run(KEYS[k as keyof IntegrationSettings], String(v))
    })()
    return this.view()
  }
}

/** VIHKO_INTEGRATIONS: unset (the switches in the UI decide) or `off`. */
export function integrationsLockedFrom(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '') return false
  if (v === 'off') return true
  throw new Error(`VIHKO_INTEGRATIONS can only be "off" (or unset), not "${raw}"`)
}
