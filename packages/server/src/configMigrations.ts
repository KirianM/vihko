// vihko.yaml rewritten to the current format when vihko starts (the
// migrations themselves are core's workspaceMigrations.ts). Only at start,
// before the configuration is read: nothing of vihko is writing the file
// then. While vihko runs, a file changed by hand is never rewritten under
// the person editing it: an old form they write is still read (with the
// deprecation warning of its version) and rewritten at the next start.
//
// - The file as it was is copied first to the state volume
//   (`config-backups/vihko.yaml.<time>`), never to the notes folder; the
//   latest KEEP_BACKUPS copies are kept.
// - The new text is written atomically (fsutil.ts), and only over the file
//   that was read: one changed meanwhile is left alone until the next start.
// - Each rewrite goes to the log and to the admins' alerts (`config_migrated`,
//   kept in `config-backups/migrations.json` until an admin dismisses it).
// - A file that isn't valid YAML is left as it is (its own workspace alert
//   says why); a migration that fails, or a file that can't be written, too:
//   the log and an admin alert (`config_migration_failed`) until the next
//   start tries again.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { WORKSPACE_FILE, WORKSPACE_MIGRATIONS, contentHash, migrateWorkspaceText, type Alert, type ConfigMigrationRef, type WorkspaceMigration } from '@vihko/core'
import { commitText, createFile, readText } from './fsutil.ts'
import { writeAtomic } from './history/recorder.ts'

/** Where the copies go, in the state volume. */
export const BACKUP_DIR = 'config-backups'
/** The copies kept: older ones go first. */
export const KEEP_BACKUPS = 10
/** The rewrites the admins are told of, until dismissed: older ones go first. */
const MAX_REWRITES = 20
const REWRITES_FILE = 'migrations.json'

export interface ConfigMigrationsOptions {
  notesDir: string
  stateDir: string
  /** The migrations to run (core's list; the tests bring their own). */
  migrations?: readonly WorkspaceMigration[]
  log?: (msg: string) => void
  now?: () => Date
}

/** A rewrite, as the admins are told of it. `backup`: the copy's path in the state volume. */
interface Rewrite {
  id: string
  at: string
  migrations: ConfigMigrationRef[]
  backup: string
}

export class ConfigMigrations {
  private opts: ConfigMigrationsOptions
  private rewrites: Rewrite[]
  /** Why the last start couldn't rewrite the file (null: it didn't need to, or it did). */
  private failure: { migration: ConfigMigrationRef | null; detail: string } | null = null

  constructor(opts: ConfigMigrationsOptions) {
    this.opts = opts
    this.rewrites = readRewrites(join(this.dir, REWRITES_FILE))
  }

  private get dir() {
    return join(this.opts.stateDir, BACKUP_DIR)
  }

  private log(msg: string) {
    this.opts.log?.(msg)
  }

  /** Rewrites the file if a migration applies (see the header). What happened. */
  async run(): Promise<'none' | 'migrated' | 'skipped' | 'failed'> {
    this.failure = null
    const migrations = this.opts.migrations ?? WORKSPACE_MIGRATIONS
    if (migrations.length === 0) return 'none'
    const file = join(this.opts.notesDir, WORKSPACE_FILE)
    let text: string | null
    try {
      text = readText(file)
    } catch (err) {
      // The workspace reports it (`unreadable`).
      this.log(`${WORKSPACE_FILE} can't be read (${(err as NodeJS.ErrnoException).code ?? String(err)}): its format isn't checked`)
      return 'skipped'
    }
    if (text === null) return 'none'
    const r = migrateWorkspaceText(text, migrations)
    if (r.kind === 'none') return 'none'
    if (r.kind === 'invalid') {
      this.log(`${WORKSPACE_FILE} isn't valid YAML: its format isn't checked until it's fixed (${r.detail})`)
      return 'skipped'
    }
    if (r.kind === 'failed') return this.fail(r.migration, r.detail)

    const at = (this.opts.now?.() ?? new Date()).toISOString()
    let backup: string
    try {
      backup = this.backup(text, at)
    } catch (err) {
      return this.fail(null, `the copy of the file couldn't be made: ${describe(err)}`)
    }
    try {
      const w = await commitText(file, r.text, contentHash(text))
      if (!w.ok) {
        rmSync(join(this.opts.stateDir, backup), { force: true })
        return this.fail(null, 'the file changed while it was being rewritten')
      }
    } catch (err) {
      rmSync(join(this.opts.stateDir, backup), { force: true })
      return this.fail(null, describe(err))
    }
    this.prune()
    this.rewrites = [...this.rewrites, { id: randomUUID(), at, migrations: r.applied, backup }].slice(-MAX_REWRITES)
    this.save()
    this.log(`${WORKSPACE_FILE} rewritten to the current format: ${r.applied.map((m) => `${m.id} (${m.description})`).join(', ')}; the file as it was is in ${join(this.opts.stateDir, backup)}`)
    return 'migrated'
  }

  /** For the admins: each rewrite until dismissed, and why the last start couldn't. */
  alerts(): Alert[] {
    const out: Alert[] = this.rewrites.map((r) => ({ code: 'config_migrated', id: r.id, file: WORKSPACE_FILE, migrations: r.migrations, backup: r.backup, at: r.at, actions: ['dismiss'] }))
    if (this.failure) out.push({ code: 'config_migration_failed', file: WORKSPACE_FILE, ...this.failure, actions: [] })
    return out
  }

  /** Dismisses a rewrite's alert (for every admin). Whether there was one. */
  dismiss(id: string): boolean {
    const before = this.rewrites.length
    this.rewrites = this.rewrites.filter((r) => r.id !== id)
    if (this.rewrites.length === before) return false
    this.save()
    return true
  }

  private fail(migration: ConfigMigrationRef | null, detail: string): 'failed' {
    this.failure = { migration, detail }
    this.log(`${WORKSPACE_FILE} not rewritten to the current format${migration ? ` (${migration.id}: ${migration.description})` : ''}: ${detail}. It's left as it was; the next start tries again`)
    return 'failed'
  }

  /** Copies the file as it was to the state volume; its path there. Never over an earlier copy. */
  private backup(text: string, at: string): string {
    mkdirSync(this.dir, { recursive: true })
    const stamp = at.replace(/:/g, '-')
    const data = Buffer.from(text, 'utf8')
    for (let n = 0; ; n++) {
      const name = `${WORKSPACE_FILE}.${stamp}${n ? `-${n}` : ''}`
      if (createFile(join(this.dir, name), data)) return `${BACKUP_DIR}/${name}`
    }
  }

  /** Only the latest copies stay (their names sort by time). */
  private prune() {
    const copies = readdirSync(this.dir).filter((n) => n.startsWith(`${WORKSPACE_FILE}.`)).sort()
    for (const name of copies.slice(0, Math.max(0, copies.length - KEEP_BACKUPS))) rmSync(join(this.dir, name), { force: true })
  }

  private save() {
    mkdirSync(this.dir, { recursive: true })
    writeAtomic(join(this.dir, REWRITES_FILE), JSON.stringify(this.rewrites))
  }
}

const describe = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))

function readRewrites(file: string): Rewrite[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(data)
      ? data.filter((r): r is Rewrite => typeof r?.id === 'string' && typeof r.at === 'string' && typeof r.backup === 'string' && Array.isArray(r.migrations))
      : []
  } catch {
    return []
  }
}
