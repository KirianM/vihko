// Keys vihko retired from its settings files, migrated by vihko itself when
// it starts. A setting that goes away isn't left as an «unknown key» for
// someone to clean up by hand on the server: each retired key is one entry
// below, with what its value asked for and how to do it now. At each start,
// before anyone can ask for anything, for every file that still has one of
// them (vihko.yaml, each person's and each shared space's
// `.vihko/settings.yaml`):
//
// 1. its entry's `migrate` does, with the value, what the key used to ask for
//    (for `templates`: marks every note of those folders as a template, each
//    through the normal edit, byte for byte but for the mark);
// 2. the key is removed from the file, the rest of it as it was (comments
//    and key order included: core `rewriteYaml`);
// 3. whom the file belongs to is told (a notice, notices.ts): the person,
//    a space's managers, or the admins for vihko.yaml.
//
// If `migrate` fails, the file keeps the key and the next start tries again;
// once the key is gone, nothing is left to do: it runs once, and running it
// again changes nothing. vihko.yaml's own format migrations (core
// workspaceMigrations.ts) are pure rewrites of the file; these have work to
// do in the notes, so they live here, after the index is ready.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { PEOPLE, SPACES, WORKSPACE_FILE, classifyPath, contentHash, deleteTopKey, noteSettingsPath, rewriteYaml, templateMarked, trimTrailingSlashes } from '@vihko/core'
import { parseYamlDocument } from '@vihko/core'
import type { Actor } from './actor.ts'
import type { Db } from './db.ts'
import { spliceOf } from './edits.ts'
import { commitText, followable, readText } from './fsutil.ts'
import type { NoteService } from './notes.ts'
import type { Notices } from './notices.ts'
import type { PermissionsFile } from './permissionsFile.ts'

/** A settings file: vihko.yaml (`root` null: its paths are from the notes root), or a space's (`root`: the space's root). */
export interface SettingsFile {
  /** Its path from the notes root. */
  path: string
  root: string | null
}

/** What migrating a retired key did: notes changed, and what the key named that no longer exists (as written). */
export interface RetiredReport {
  marked: number
  missing: string[]
}

export interface RetiredContext {
  file: SettingsFile
  notesDir: string
  /** Whether a folder (from the notes root) is there. */
  isFolder: (path: string) => boolean
  /** The people's usernames (for `{user}` in vihko.yaml). */
  people: () => string[]
  /** Marks every note in `folder` (its subfolders included) as a template; how many it changed. */
  markTemplates: (folder: string, file: SettingsFile) => Promise<number>
}

export interface RetiredKey {
  /** The top-level key, as written in the file. */
  key: string
  /** Which files it was a key of. */
  in: readonly ('workspace' | 'space')[]
  /** Does now what the key's value asked for. May throw: the key stays, and the next start tries again. */
  migrate: (value: unknown, ctx: RetiredContext) => Promise<RetiredReport>
}

/** The folders a `templates` value names: one, or a list. */
function folderList(value: unknown): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  return list.filter((v): v is string => typeof v === 'string').map((v) => trimTrailingSlashes(v.trim().normalize('NFC'))).filter((v) => v !== '')
}

/** A folder as written, where it is from the notes root; null if it leaves its place (`..`, a hidden folder, an absolute path). */
function placed(folder: string, root: string | null): string | null {
  const parts = folder.split('/')
  if (folder.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return null
  return root === null ? folder : `${root}/${folder}`
}

/**
 * The retired keys, oldest first. Retiring another one is one entry here,
 * with a test.
 */
export const RETIRED_KEYS: readonly RetiredKey[] = [
  {
    // 0.1.0-rc.5: templates are notes marked `template: true`, not folders.
    key: 'templates',
    in: ['workspace', 'space'],
    async migrate(value, ctx) {
      const report: RetiredReport = { marked: 0, missing: [] }
      for (const written of folderList(value)) {
        // `{user}` in vihko.yaml: each person's own folder.
        const folders = ctx.file.root === null && written.includes('{user}') ? ctx.people().map((u) => written.replaceAll('{user}', u)) : [written]
        let found = false
        for (const f of folders) {
          const at = placed(f, ctx.file.root)
          if (at === null || !ctx.isFolder(at)) continue
          found = true
          report.marked += await ctx.markTemplates(at, ctx.file)
        }
        if (!found) report.missing.push(written)
      }
      return report
    },
  },
]

export interface RetiredKeysDeps {
  notesDir: string
  index: Db
  state: Db
  notes: NoteService
  file: PermissionsFile
  notices: Notices
  /** The managers of a shared space (usernames). */
  managersOf: (root: string) => string[]
  log?: (msg: string) => void
  keys?: readonly RetiredKey[]
}

/** What a start did: for each file that had a retired key, the key and what migrating it did. */
export interface RetiredKeysReport {
  migrated: { file: string; key: string; report: RetiredReport }[]
  failed: { file: string; key: string; detail: string }[]
}

/** Folders of `dir` (a name each), none if it can't be read. */
function folders(abs: string): string[] {
  try {
    return readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return []
  }
}

/** Migrates every retired key in every settings file (see the header). */
export async function migrateRetiredKeys(deps: RetiredKeysDeps): Promise<RetiredKeysReport> {
  const out: RetiredKeysReport = { migrated: [], failed: [] }
  const keys = deps.keys ?? RETIRED_KEYS
  const people = () => folders(join(deps.notesDir, PEOPLE))
  const files: SettingsFile[] = [
    { path: WORKSPACE_FILE, root: null },
    ...people().map((u) => ({ path: noteSettingsPath(`${PEOPLE}/${u}`), root: `${PEOPLE}/${u}` })),
    ...folders(join(deps.notesDir, SPACES)).map((s) => ({ path: noteSettingsPath(`${SPACES}/${s}`), root: `${SPACES}/${s}` })),
  ]
  const markTemplates = async (folder: string, file: SettingsFile) => {
    const esc = folder.replace(/[\\%_]/g, (c) => '\\' + c)
    const paths = (deps.index.prepare("select path from notes where path like ? escape '\\' order by path").all(`${esc}/%`) as { path: string }[]).map((r) => r.path)
    const actor: Actor = { kind: 'system', reason: { code: 'templates_marked', folder, file: file.path } }
    let n = 0
    for (const p of paths) {
      let changed = false
      try {
        await deps.notes.edit(p, (t) => {
          const next = templateMarked(t, true)
          // A frontmatter that can't be read is left as it is, as «Mark notes as templates…» does.
          if (next === null || next === t) return []
          changed = true
          return [spliceOf(t, 0, t.length, next)]
        }, { actor })
      } catch {
        continue // gone meanwhile, or unreadable: nothing to mark
      }
      if (changed) n++
    }
    return n
  }
  const ctxOf = (file: SettingsFile): RetiredContext => ({
    file, notesDir: deps.notesDir, people, markTemplates,
    isFolder: (p) => {
      try { return classifyPath(p) !== 'ignored' && statSync(join(deps.notesDir, p)).isDirectory() && followable(deps.notesDir, p) } catch { return false }
    },
  })

  for (const file of files) {
    const abs = join(deps.notesDir, file.path)
    // A person's or a space's settings are never read or written through a
    // symbolic link (the file, or `.vihko/`): it could lead out of the notes
    // folder, or into another space's settings. vihko.yaml goes through its own store.
    if (file.root !== null && !followable(deps.notesDir, file.path)) continue
    let text = file.root === null ? deps.file.read().text : readText(abs)
    if (text === null) continue
    for (const k of keys) {
      if (!k.in.includes(file.root === null ? 'workspace' : 'space')) continue
      const doc = parseYamlDocument(text)
      if (doc.errors.length || !doc.has(k.key)) continue
      let report: RetiredReport
      try {
        report = await k.migrate((doc.toJS() as Record<string, unknown>)[k.key] ?? null, ctxOf(file))
        const next = rewriteYaml(text, (d) => deleteTopKey(d, k.key))
        if (next !== null) {
          if (file.root === null) {
            await deps.file.update((t) => rewriteYaml(t, (d) => deleteTopKey(d, k.key)) ?? t, { actor: { kind: 'system', reason: { code: 'templates_marked', folder: '', file: file.path } } })
          } else {
            const w = await commitText(abs, next, contentHash(text))
            if (!w.ok) throw new Error('the file changed while it was being rewritten')
          }
          text = next
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        out.failed.push({ file: file.path, key: k.key, detail })
        deps.log?.(`${file.path}: the retired key ${k.key} couldn't be migrated, it stays for the next start: ${detail}`)
        continue
      }
      out.migrated.push({ file: file.path, key: k.key, report })
      deps.log?.(`${file.path}: the retired key ${k.key} migrated (${report.marked} note(s) changed${report.missing.length ? `, ${report.missing.length} folder(s) no longer there` : ''}) and removed from the file`)
      for (const id of ownersOf(deps, file)) deps.notices.add(id, { code: 'settings_migrated', key: k.key, file: file.path, marked: report.marked, missing: report.missing })
    }
  }
  return out
}

/** Whom a settings file belongs to (user ids): the admins for vihko.yaml, the person for theirs, a space's managers for its. */
function ownersOf(deps: RetiredKeysDeps, file: SettingsFile): string[] {
  const live = (rows: unknown[]) => (rows as { id: string }[]).map((r) => r.id)
  if (file.root === null) return live(deps.state.prepare("select id from users where role = 'admin' and deleted_at is null").all())
  const byName = deps.state.prepare('select id from users where username = ? and deleted_at is null')
  const names = file.root.startsWith(`${PEOPLE}/`) ? [file.root.slice(PEOPLE.length + 1)] : deps.managersOf(file.root)
  return names.flatMap((n) => live(byName.all(n)))
}
