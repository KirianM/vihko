// Installation settings the thoth admin changes in «Users and groups»
// (state.db; no row = the default). They apply at once.
import type { Db } from './db.ts'

export interface AdminSettingsView {
  /**
   * Members may «Save a copy» of an image from an address on the local
   * network (D-038.6). Off by default: members only download from public
   * addresses, so the server can't be used to probe the network it's in.
   * The thoth admin always may.
   */
  membersLocalDownloads: boolean
}

const DEFAULTS: AdminSettingsView = { membersLocalDownloads: false }

const KEYS: Record<keyof AdminSettingsView, string> = {
  membersLocalDownloads: 'admin.membersLocalDownloads',
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
    const out = { ...DEFAULTS }
    for (const k of Object.keys(KEYS) as (keyof AdminSettingsView)[]) {
      const v = stored.get(KEYS[k])
      if (v === 'true' || v === 'false') out[k] = v === 'true'
    }
    return out
  }

  /** Changes some settings, all or none. */
  set(patch: Record<string, unknown>): AdminSettingsView {
    const entries = Object.entries(patch ?? {}).filter(([, v]) => v !== undefined)
    for (const [k, v] of entries) {
      if (!(k in KEYS)) throw new AdminSettingsError(`unknown setting: ${k}`)
      if (typeof v !== 'boolean') throw new AdminSettingsError(`${k} must be true or false`)
    }
    const put = this.db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
    this.db.transaction(() => {
      for (const [k, v] of entries) put.run(KEYS[k as keyof AdminSettingsView], String(v))
    })()
    return this.view()
  }
}
