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
  /**
   * Who may create shared spaces (D-056.5): `everyone` (the default; whoever
   * creates one is its first manager) or `admins` only.
   */
  spacesCreation: SpacesCreation
  /**
   * Trash entries deleted more than this many days ago are removed for good,
   * with their images, at the weekly run (retention.ts). Null, the default:
   * the trash is never emptied on its own.
   */
  trashRetentionDays: number | null
  /**
   * History versions older than this many days are removed at the weekly
   * run, keeping each note's version at that moment (history/retention.ts).
   * Null, the default: the history keeps everything.
   */
  historyRetentionDays: number | null
}

/** Who may create shared spaces. */
export type SpacesCreation = 'everyone' | 'admins'
export const SPACES_CREATION: readonly SpacesCreation[] = ['everyone', 'admins']

/** The longest retention period, in days (100 years): anything longer is «keep everything». */
export const MAX_RETENTION_DAYS = 36500

const DEFAULTS: AdminSettingsView = { membersLocalDownloads: false, twoFactor: 'optional', spacesCreation: 'everyone', trashRetentionDays: null, historyRetentionDays: null }

const KEYS: Record<keyof AdminSettingsView, string> = {
  membersLocalDownloads: 'admin.membersLocalDownloads',
  twoFactor: 'admin.twoFactor',
  spacesCreation: 'admin.spacesCreation',
  trashRetentionDays: 'admin.trashRetentionDays',
  historyRetentionDays: 'admin.historyRetentionDays',
}

const isDays = (v: unknown): v is number | null => v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_RETENTION_DAYS)

/** What each setting may be. */
const VALID: { [K in keyof AdminSettingsView]: (v: unknown) => v is AdminSettingsView[K] } = {
  membersLocalDownloads: (v): v is boolean => typeof v === 'boolean',
  twoFactor: (v): v is TwoFactorPolicy => POLICIES.includes(v as TwoFactorPolicy),
  spacesCreation: (v): v is SpacesCreation => SPACES_CREATION.includes(v as SpacesCreation),
  trashRetentionDays: isDays,
  historyRetentionDays: isDays,
}

/** How a setting is kept as text, and read back (anything else: the default). */
function parse(k: keyof AdminSettingsView, raw: string): unknown {
  if (typeof DEFAULTS[k] === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : undefined
  if (k === 'trashRetentionDays' || k === 'historyRetentionDays') return /^\d+$/.test(raw) ? Number(raw) : undefined
  return raw
}

/**
 * Whether `patch` turns a retention period on or shortens it: it removes
 * more than before, and is confirmed at the moment.
 */
export function retentionTightened(now: AdminSettingsView, patch: Record<string, unknown>): boolean {
  return (['trashRetentionDays', 'historyRetentionDays'] as const).some((k) => {
    const v = patch[k]
    if (v === undefined || v === null || !isDays(v)) return false
    const was = now[k]
    return was === null || v < was
  })
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
      const v = parse(k, raw)
      if (VALID[k](v)) out[k] = v
    }
    return out as unknown as AdminSettingsView
  }

  /** The second factor's policy now. */
  twoFactorPolicy(): TwoFactorPolicy {
    return this.view().twoFactor
  }

  /** Who may create shared spaces now. */
  spacesCreation(): SpacesCreation {
    return this.view().spacesCreation
  }

  /** Changes some settings, all or none. A retention period set to null turns it off. */
  set(patch: Record<string, unknown>): AdminSettingsView {
    const entries = Object.entries(patch ?? {}).filter(([, v]) => v !== undefined)
    for (const [k, v] of entries) {
      if (!(k in KEYS)) throw new AdminSettingsError(`unknown setting: ${k}`)
      if (!VALID[k as keyof AdminSettingsView](v)) {
        const one = k === 'twoFactor' ? POLICIES : k === 'spacesCreation' ? SPACES_CREATION : null
        if (one) throw new AdminSettingsError(`${k} must be one of ${one.join(', ')}`)
        if (k === 'trashRetentionDays' || k === 'historyRetentionDays') throw new AdminSettingsError(`${k} must be null (off) or a whole number of days from 1 to ${MAX_RETENTION_DAYS}`)
        throw new AdminSettingsError(`${k} must be true or false`)
      }
    }
    const put = this.db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
    const drop = this.db.prepare('delete from settings where key = ?')
    this.db.transaction(() => {
      for (const [k, v] of entries) {
        const key = KEYS[k as keyof AdminSettingsView]
        if (v === null) drop.run(key)
        else put.run(key, String(v))
      }
    })()
    return this.view()
  }
}
