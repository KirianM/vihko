// What the log says about notes. A personal space is one person's, and so are
// the names of their notes: at the `info` level (the default) a path inside
// one is never written to the log, only that it is in a personal space and,
// for a note, its `uid` when it has one (enough to find it with the index or
// a search). At `debug` (VIHKO_LOG_LEVEL=debug, to chase a problem) paths
// are written whole. Shared spaces' paths are written at either level: their
// names are their members'.
import { PEOPLE, classifyPath } from '@vihko/core'

export type LogLevel = 'info' | 'debug'
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'debug']

let level: LogLevel = 'info'
let uidOf: (path: string) => string | null = () => null

/** The level, and how to find a note's `uid` by its path (the index's). */
export function configureLogging(opts: { level?: LogLevel; uidOf?: (path: string) => string | null }) {
  if (opts.level) level = opts.level
  if (opts.uidOf) uidOf = opts.uidOf
}

const inPersonal = (path: string) => path.startsWith(`${PEOPLE}/`) && path.length > PEOPLE.length + 1

/** A path as the log may say it: whole in a shared space or at `debug`; in a personal space, what it is, and its note's `uid`. */
export function shownPath(path: string): string {
  if (level === 'debug' || !inPersonal(path)) return path
  const rest = path.slice(PEOPLE.length + 1)
  if (!rest.includes('/')) return 'a personal space'
  if (classifyPath(path) !== 'note') return 'a file or folder in a personal space'
  let uid: string | null = null
  try { uid = uidOf(path) } catch { /* the index isn't there: no uid */ }
  return uid ? `a note in a personal space (uid ${uid})` : 'a note in a personal space'
}

/**
 * A log line as it may be written: at `info`, any path of a personal space
 * still in it (an error's message, say) cut down to that. Paths are written
 * as vihko gives them (`people/<user>/…`, or on the disk, after the notes
 * folder); one with spaces in its name is cut up to the `.md` that ends it.
 */
export function scrub(line: string): string {
  if (level === 'debug') return line
  return line.replace(/(?<![\w.-])people\/[^\s/:,;)"'»]+(?:\/(?:[^\n:,;)"'»]*?\.md\b|[^\s:,;)"'»]*))?/g, (p) => (p.split('/').length > 2 ? 'a path in a personal space' : 'a personal space'))
}
