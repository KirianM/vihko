// The shared spaces of 0.1.0-rc.1 and rc.2, renamed to their names when vihko
// starts (D-056.33). Those versions made a shared space's folder
// `spaces/<readable>-<id>/` and kept its name in vihko.yaml (`name`, at its
// root); now the folder is the name. Each start, before vihko listens:
//
// - every shared space whose root rule has a `name` is renamed to it, as a
//   folder renamed from vihko is (scoped.ts): its rules first at the new
//   path too (without `name`), then the folder with everything in it (the
//   index, the history and open notes follow, notes.ts), then its old rules
//   go, and keys, pins and the trash follow (folderRefs.ts). Links don't
//   change: they never leave a space (D-056.30).
// - A name that can't be a folder's (a `/` in it, say) gives way to the
//   folder's readable part (`casa` of `casa-7k2q9x`).
// - A name another space or folder in `spaces/` has, in any case (core
//   nameKey), leaves the space as it is, `name` included, and the admins see
//   `space_not_renamed` (spaceAlerts.ts) until it is renamed: the next start
//   tries again, and its managers can rename it.
// - A space whose name already is its folder only loses `name`.
//
// Only `name` marks such a space: vihko never writes it now. A folder named
// like `notes-equipo` by someone today has no `name`, so it is never touched.
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SPACES, legacySpaceFolder, nameKey, parseSpacePath, rulesInFile, setRule, sharedRoot, spaceNameProblem } from '@vihko/core'
import type { Actor } from './actor.ts'
import type { FolderRefs } from './folderRefs.ts'
import type { Indexer } from './indexer.ts'
import type { NoteService } from './notes.ts'
import type { PermissionsFile } from './permissionsFile.ts'

export interface LegacySpacesDeps {
  notesDir: string
  file: PermissionsFile
  notes: NoteService
  refs: FolderRefs
  indexer: Indexer
  log?: (msg: string) => void
}

/** What a start did: the spaces renamed, and those left as they were (`wanted`: the name they couldn't take). */
export interface LegacySpacesReport {
  renamed: { from: string; to: string }[]
  left: { path: string; wanted: string }[]
}

/** The name a legacy space takes: its `name`, or its folder's readable part when that can't be a folder's; null if neither can. */
export function legacyTarget(name: string, folder: string): string | null {
  const n = name.normalize('NFC')
  if (spaceNameProblem(n) === null) return n
  const readable = legacySpaceFolder(folder)?.readable ?? null
  return readable !== null && spaceNameProblem(readable) === null ? readable : null
}

/** Renames the legacy shared spaces to their names (see the header). */
export async function renameLegacySpaces(deps: LegacySpacesDeps): Promise<LegacySpacesReport> {
  const report: LegacySpacesReport = { renamed: [], left: [] }
  const log = (msg: string) => deps.log?.(msg)
  let rules: ReturnType<typeof rulesInFile>
  try {
    rules = rulesInFile(deps.file.read().text ?? '')
  } catch {
    // Not valid YAML: the workspace says so; the next start tries again.
    return report
  }
  const legacy = [...rules].filter(([folder, v]) => {
    const s = parseSpacePath(folder)
    return typeof v.name === 'string' && s?.space.kind === 'shared' && s.inner === '' && isFolder(deps.notesDir, folder)
  })
  if (legacy.length === 0) return report
  // What `spaces/` has now, by name key; renames update it as they go.
  const names = new Map<string, string>()
  try {
    for (const e of readdirSync(join(deps.notesDir, SPACES))) if (!e.startsWith('.')) names.set(nameKey(e), sharedRoot(e))
  } catch { /* nothing there */ }
  for (const [from, v] of legacy) {
    const folder = parseSpacePath(from)!.space
    if (folder.kind !== 'shared') continue
    const actor: Actor = { kind: 'system', reason: { code: 'space_renamed', from, to: from } }
    const wanted = legacyTarget(v.name!, folder.folder)
    const to = wanted === null ? from : sharedRoot(wanted)
    try {
      if (to === from) {
        // Its name already is its folder (or none can be): only `name` goes.
        await deps.file.update((t) => {
          const now = rulesInFile(t).get(from)
          return now ? setRule(t, from, { grants: now.grants, ai: now.ai, name: null }) : t
        }, { actor })
        continue
      }
      const holder = names.get(nameKey(wanted!))
      if (holder !== undefined && holder !== from) {
        report.left.push({ path: from, wanted: wanted! })
        log(`the shared space ${from} keeps its folder: its name «${wanted}» is taken in ${SPACES}/ (the admins are told; the next start tries again)`)
        continue
      }
      await moveSpace(deps, from, to, { kind: 'system', reason: { code: 'space_renamed', from, to } })
      names.delete(nameKey(folder.folder))
      names.set(nameKey(wanted!), to)
      report.renamed.push({ from, to })
      log(`the shared space ${from} is now ${to} (its name, D-056.33)`)
    } catch (err) {
      report.left.push({ path: from, wanted: wanted ?? folder.folder })
      log(`the shared space ${from} couldn't be renamed to ${to}: ${err instanceof Error ? err.message : String(err)} (the next start tries again)`)
    }
  }
  return report
}

/** Renames a space's folder from vihko, its rules first (see the header). */
async function moveSpace(deps: LegacySpacesDeps, from: string, to: string, actor: Actor) {
  const before = deps.file.read().text ?? ''
  const own = rulesInFile(before).get(from)
  await deps.file.moveRules(from, to, { actor, keepFrom: true, extra: [{ folder: to, grants: own?.grants ?? null, ai: own?.ai ?? null, name: null }] })
  const copied = deps.file.read().text
  try {
    await deps.notes.moveFolder(from, to, { actor })
  } catch (err) {
    // It didn't move: the copies go, unless someone changed the file meanwhile.
    await deps.file.update((x) => (x === copied ? before : x), { actor }).catch(() => {})
    throw err
  }
  await deps.file.removeRules(from, { actor })
  deps.refs.moved(from, to)
  deps.indexer.indexFolders([from, to])
}

function isFolder(notesDir: string, folder: string): boolean {
  try {
    return lstatSync(join(notesDir, folder)).isDirectory()
  } catch {
    return false
  }
}
