// What was purged from the history while thoth ran (D-038.9), for the admin:
// the path, the version if it was one, who purged it and when. Never
// anything of the content. Kept in the state volume (`history/purges.json`,
// written whole: temporary file, fsync, rename) until the admin dismisses
// each one; only the latest are kept.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeAtomic } from './recorder.ts'

export interface PurgeNotice {
  id: string
  path: string
  version: string | null
  /** The id of the user who purged it. */
  by: string
  /** ISO. */
  at: string
}

/** The most notices kept: older ones go first. */
const MAX_NOTICES = 200

export class PurgeNotices {
  private file: string
  private list: PurgeNotice[]

  constructor(stateDir: string) {
    this.file = join(stateDir, 'history', 'purges.json')
    this.list = read(this.file)
  }

  all(): readonly PurgeNotice[] {
    return this.list
  }

  add(n: Omit<PurgeNotice, 'id'>): PurgeNotice {
    const notice = { id: randomUUID(), ...n }
    this.list = [...this.list, notice].slice(-MAX_NOTICES)
    this.save()
    return notice
  }

  /** Whether there was one with that id. */
  dismiss(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter((n) => n.id !== id)
    if (this.list.length === before) return false
    this.save()
    return true
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeAtomic(this.file, JSON.stringify(this.list))
  }
}

function read(file: string): PurgeNotice[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(data) ? data.filter((n): n is PurgeNotice => typeof n?.id === 'string' && typeof n.path === 'string' && typeof n.by === 'string' && typeof n.at === 'string') : []
  } catch {
    return []
  }
}
