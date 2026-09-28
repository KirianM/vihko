// Installation settings the vihko admin changes in «Users and groups»
// (state.db; no row = the default). They apply at once.
import type { Db } from './db.ts'
import { POLICIES, type TwoFactorPolicy } from './twoFactor.ts'

export interface AdminSettingsView {
  /**
   * Members may «Save a copy» of an image from an address on the local
   * network (D-038.6). Off by default: members only download from public
   * addresses, so the server can't be used to probe the network it's in.
   * The vihko admin always may.
   */
  membersLocalDownloads: boolean
  /**
   * The second factor (D-036): `required` (whoever hasn't set it up does so
   * at their next sign-in, before anything else), `optional` (the default:
   * each person chooses) or `disabled` (nobody new sets one up; whoever has
   * one is still asked for it, D-040 3.4a).
   */
  twoFactor: TwoFactorPolicy
}

const DEFAULTS: AdminSettingsView = { membersLocalDownloads: false, twoFactor: 'optional' }

const KEYS: Record<keyof AdminSettingsView, string> = {
  membersLocalDownloads: 'admin.membersLocalDownloads',
  twoFactor: 'admin.twoFactor',
}

/** What each setting may be. */
const VALID: { [K in keyof AdminSettingsView]: (v: unknown) => v is AdminSettingsView[K] } = {
  membersLocalDownloads: (v): v is boolean => typeof v === 'boolean',
  twoFactor: (v): v is TwoFactorPolicy => POLICIES.includes(v as TwoFactorPolicy),
}

export class AdminSettingsError extends Error {
  readonly code = 'invalid'
}

export class AdminSettings {
  private db: Db

  constructor(state: Db) {
    this.db = state
  }

  view(): AdminSettingsView {
    const rows = this.db.prepare("select key, value from settings where key like 'admin.%'").all() as { key: string; value: string }[]
    const stored = new Map(rows.map((r) => [r.key, r.value]))
    const out: Record<string, unknown> = { ...DEFAULTS }
    for (const k of Object.keys(KEYS) as (keyof AdminSettingsView)[]) {
      const raw = stored.get(KEYS[k])
      if (raw === undefined) continue
      const v = typeof DEFAULTS[k] === 'boolean' ? (raw === 'true' ? true : raw === 'false' ? false : undefined) : raw
      if (VALID[k](v)) out[k] = v
    }
    return out as unknown as AdminSettingsView
  }

  /** The second factor's policy now. */
  twoFactorPolicy(): TwoFactorPolicy {
    return this.view().twoFactor
  }

  /** Changes some settings, all or none. */
  set(patch: Record<string, unknown>): AdminSettingsView {
    const entries = Object.entries(patch ?? {}).filter(([, v]) => v !== undefined)
    for (const [k, v] of entries) {
      if (!(k in KEYS)) throw new AdminSettingsError(`unknown setting: ${k}`)
      if (!VALID[k as keyof AdminSettingsView](v)) {
        throw new AdminSettingsError(k === 'twoFactor' ? `${k} must be one of ${POLICIES.join(', ')}` : `${k} must be true or false`)
      }
    }
    const put = this.db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
    this.db.transaction(() => {
      for (const [k, v] of entries) put.run(KEYS[k as keyof AdminSettingsView], String(v))
    })()
    return this.view()
  }
}
