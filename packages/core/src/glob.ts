import { trimTrailingSlashes } from './paths.ts'
// Path patterns relative to the root of the notes folder, for `history.exclude`
// in vihko.yaml. A minimal glob of vihko's own, with no dependency:
//
//   *    any characters within one folder or file name (never `/`)
//   ?    exactly one character (never `/`)
//   **   a whole segment: any number of folders, none included
//
// A pattern covers the path it matches and everything under it, so a folder
// is excluded with its name (`biblioteca`, `biblioteca/` or `biblioteca/**`).
// `*.pdf` only matches at the root; `**/*.pdf` matches in any folder.
// Names are compared in Unicode NFC, so a pattern typed on one system matches
// a name stored decomposed (NFD) by another. Case matters.
//
// Anything else is taken literally, except what other globs give a meaning
// vihko doesn't: `[…]`, `{…}`, a leading `!` and `\`. A pattern with them is
// invalid rather than silently matching nothing.

/** Why a pattern is invalid (developer-facing; the UI words the config code). */
export type GlobProblem = 'empty' | 'absolute' | 'segment' | 'double_star' | 'unsupported'

/** Checks a pattern; null if it's valid. */
export function globProblem(pattern: string): GlobProblem | null {
  const p = trimTrailingSlashes(pattern)
  if (p.trim() === '') return 'empty'
  if (p.startsWith('/')) return 'absolute'
  if (/[\u0000-\u001f\u007f]/.test(p) || /[[\]{}\\]/.test(p) || p.startsWith('!')) return 'unsupported'
  for (const s of p.split('/')) {
    if (s === '' || s === '.' || s === '..') return 'segment'
    if (s !== '**' && s.includes('**')) return 'double_star'
  }
  return null
}

/** The expression for a valid pattern: the path it names, or anything under it. */
function compile(pattern: string): RegExp {
  const segments = trimTrailingSlashes(pattern.normalize('NFC')).split('/')
  let re = ''
  let slash = false
  segments.forEach((s, i) => {
    const last = i === segments.length - 1
    if (s === '**') {
      re += last ? (slash ? '(?:/.*)?' : '.*') : (slash ? '(?:/.*)?/' : '(?:.*/)?')
      slash = false
      return
    }
    if (slash) re += '/'
    re += [...s].map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.*+?^$()|[\]{}\\/]/g, '\\$&'))).join('')
    slash = true
  })
  return new RegExp(`^${re}(?:/.*)?$`, 'su')
}

/**
 * A matcher for a list of patterns: true if any covers the path (relative to
 * the notes root, `/`-separated). Invalid patterns are left out (the
 * configuration reports them before they get here).
 */
export function pathMatcher(patterns: readonly string[]): (path: string) => boolean {
  const res = patterns.filter((p) => globProblem(p) === null).map(compile)
  if (res.length === 0) return () => false
  return (path) => {
    const p = path.normalize('NFC')
    return res.some((re) => re.test(p))
  }
}
