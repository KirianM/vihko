// Each person's own folder, `people/<username>`: made when the user is created, so that «My notes» and the external
// editors find it from the first day, for the first admin and for a
// single-person install alike. And the two folders of the product, `people/`
// and `spaces/`, made when vihko starts if they are missing.
//
// - A folder for the new name that already exists with something in it was
//   made outside vihko: creating the user is refused (`personal_folder_exists`)
//   rather than handing them whatever is there, unless the admin chooses to
//   adopt it (`adopt`: someone recreated after state.db was lost). An empty
//   one is theirs.
// - Names are compared as users are (full case folding, core `nameKey`): on a
//   case-insensitive volume `people/Ana` is the folder of `ana` too, and an
//   empty one spelled otherwise is replaced by one spelled as the username
//   (paths are read as the disk spells them, fsutil.ts `followable`).
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { PEOPLE, SPACES, nameKey, personalRoot } from '@vihko/core'

/** A new user's folder exists with something in it (409 `personal_folder_exists`). */
export class PersonalFolderExists extends Error {
  readonly code = 'personal_folder_exists'
}

export class PersonalFolders {
  readonly notesDir: string

  constructor(notesDir: string) {
    this.notesDir = notesDir
  }

  /**
   * `people/` and `spaces/`, made if missing. What else is at the root is
   * left alone. Never the notes folder itself: one that isn't there (a volume
   * not mounted) stays missing, for the scan to tell.
   */
  ensureLayout(): void {
    for (const top of [PEOPLE, SPACES]) {
      try {
        mkdirSync(join(this.notesDir, top))
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOENT') throw err
      }
    }
  }

  /** The entries of `people/` whose name is `username`'s (any case), as the disk spells them. */
  private matching(username: string): string[] {
    const key = nameKey(username.normalize('NFC'))
    try {
      return readdirSync(join(this.notesDir, PEOPLE)).filter((e) => nameKey(e.normalize('NFC')) === key)
    } catch {
      return []
    }
  }

  /** Whether an entry of `people/` is an empty folder (never through a symbolic link). */
  private emptyFolder(entry: string): boolean {
    const p = join(this.notesDir, PEOPLE, entry)
    try {
      return lstatSync(p).isDirectory() && readdirSync(p).length === 0
    } catch {
      return false
    }
  }

  /**
   * Throws PersonalFolderExists unless `username` may get its folder: none
   * there yet, or only empty ones. Changes nothing.
   */
  check(username: string): void {
    for (const e of this.matching(username)) {
      if (!this.emptyFolder(e)) throw new PersonalFolderExists(`${personalRoot(e)} already exists with something in it: move it out of the way, or choose another name`)
    }
  }

  /**
   * Makes `username`'s folder (checked first, as `check`). An empty one
   * spelled otherwise goes first. Whether it made it (false: it was there,
   * empty, as spelled). With `adopt`, a folder there with something in it
   * becomes theirs as it is (the admin's explicit choice, for someone
   * recreated after state.db was lost): spelled otherwise, it's renamed to
   * their name; more than one such folder is still refused.
   */
  make(username: string, opts: { adopt?: boolean } = {}): boolean {
    const name = username.normalize('NFC')
    if (opts.adopt) {
      const full = this.matching(name).filter((e) => !this.emptyFolder(e))
      if (full.length > 1) throw new PersonalFolderExists(`more than one folder in ${PEOPLE}/ has the name ${name} in some case: keep only one`)
      if (full.length === 1) {
        const [e] = full as [string]
        for (const other of this.matching(name)) if (other !== e) rmdirSync(join(this.notesDir, PEOPLE, other))
        if (e !== name) {
          // Through another name: on a volume without case, renaming to another case of itself may do nothing.
          const aside = join(this.notesDir, PEOPLE, `.adopting-${process.pid}-${Date.now()}`)
          renameSync(join(this.notesDir, PEOPLE, e), aside)
          renameSync(aside, join(this.notesDir, personalRoot(name)))
        }
        return false
      }
    }
    this.check(username)
    for (const e of this.matching(name)) if (e !== name) rmdirSync(join(this.notesDir, PEOPLE, e))
    this.ensureLayout()
    try {
      mkdirSync(join(this.notesDir, personalRoot(name)))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && this.emptyFolder(name)) return false
      throw err
    }
  }

  /**
   * A user's folder, made if nothing of theirs is there (at start, for the
   * users there are: one removed outside vihko comes back empty). One there
   * with something in it is theirs, whatever it holds.
   */
  ensure(username: string): void {
    if (this.matching(username).length > 0) return
    try {
      mkdirSync(join(this.notesDir, personalRoot(username)))
    } catch (err) {
      // No `people/` (the notes folder isn't there): nothing is made.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOENT') throw err
    }
  }

  /** Undoes `make` (the user couldn't be created after all): only while it's still empty. */
  unmake(username: string): void {
    try {
      rmdirSync(join(this.notesDir, personalRoot(username)))
    } catch {
      // Not there, or something landed in it meanwhile: left as it is.
    }
  }
}
