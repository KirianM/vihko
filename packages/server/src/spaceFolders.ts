// What of the spaces exists on the disk, for the permissions engine
// (permissions.ts SpaceFolders): the folders under `spaces/`, and whether a
// shared folder exists. Read each time it's asked (a handful of entries):
// spaces made or removed outside vihko show at once, on NFS too.
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SPACES } from '@vihko/core'
import { followable } from './fsutil.ts'
import type { SpaceFolders } from './permissions.ts'

/** The spaces of the notes folder `notesDir`: never through a symbolic link, only as the disk spells each name (fsutil.ts followable). */
export function diskSpaceFolders(notesDir: string): SpaceFolders {
  return {
    shared: () => {
      try {
        return readdirSync(join(notesDir, SPACES), { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name)
      } catch {
        return []
      }
    },
    exists: (folder) => {
      try {
        return lstatSync(join(notesDir, folder)).isDirectory() && followable(notesDir, folder)
      } catch {
        return false
      }
    },
  }
}
