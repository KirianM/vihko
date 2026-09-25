// Editor suggestions without CodeMirror: which completion the text before the
// cursor asks for, how notes, headings and tags rank against what was typed,
// and the shortest link that reaches a note from the current one (D-019).
// Plain data in and out, so it can be tested on its own.
import { caseFold } from '@thoth/core/casefold'
import { LinkIndex, shortestTarget } from '@thoth/core/resolve'

/** A note as the tree lists it. */
export interface NoteEntry { path: string; title: string; aliases?: readonly string[] }
export interface TagEntry { tag: string; count: number }
export interface HeadingEntry { level: number; text: string }

/** What the text before the cursor (on its line) is completing. `query` is what's typed so far. */
export type Context =
  | { kind: 'note'; query: string }
  | { kind: 'heading'; target: string; query: string }
  | { kind: 'display'; target: string; query: string }
  | { kind: 'tag'; query: string }

const TAG_BEFORE = /(^|[\s(])#([\p{L}\p{N}_\-/]*)$/u

export function completionContext(before: string): Context | null {
  const open = before.lastIndexOf('[[')
  if (open !== -1 && !before.includes(']]', open)) {
    const inner = before.slice(open + 2)
    if (inner.includes('[') || inner.includes(']')) return null
    const bar = inner.indexOf('|')
    if (bar !== -1) return { kind: 'display', target: inner.slice(0, bar).replace(/#.*$/, '').trim(), query: inner.slice(bar + 1) }
    const hash = inner.indexOf('#')
    if (hash !== -1) return { kind: 'heading', target: inner.slice(0, hash).trim(), query: inner.slice(hash + 1) }
    return { kind: 'note', query: inner }
  }
  const tag = TAG_BEFORE.exec(before)
  if (!tag) return null
  const query = tag[2]!
  // `#` alone at the start of a line is most likely a heading on its way (`# `).
  if (query === '' && before.slice(0, tag.index + tag[1]!.length).trim() === '') return null
  return { kind: 'tag', query }
}

/** Case- and accent-insensitive form, like search (`unicode61 remove_diacritics`), with the case folding of links and tags. */
export const fold = (s: string) => caseFold(s).normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim()

const WORD_START = /[\s\-_/.(),:;[\]]/

/**
 * How well `text` matches `query` (both folded), higher is better, -1 is no
 * match: exact, prefix, a word starting with it, contained, every word of the
 * query contained, the query's letters in order.
 */
export function matchScore(text: string, query: string): number {
  if (query === '') return 0
  if (text === query) return 100
  if (text.startsWith(query)) return 80
  const at = text.indexOf(query)
  if (at > 0 && WORD_START.test(text[at - 1]!)) return 60
  for (let i = text.indexOf(query, at + 1); at !== -1 && i !== -1; i = text.indexOf(query, i + 1)) {
    if (WORD_START.test(text[i - 1]!)) return 60
  }
  if (at !== -1) return 40
  const words = query.split(' ').filter(Boolean)
  if (words.length > 1 && words.every((w) => text.includes(w))) return 30
  if (query.length >= 2 && subsequence(text, query)) return 10
  return -1
}

function subsequence(text: string, query: string) {
  let j = 0
  for (let i = 0; i < text.length && j < query.length; i++) if (text[i] === query[j]) j++
  return j === query.length
}

const stripMd = (p: string) => p.replace(/\.md$/i, '')
export const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const baseName = (p: string) => stripMd(p.slice(p.lastIndexOf('/') + 1))

export interface NoteMatch {
  path: string
  /** What's shown: the title, the file name, or the alias that matched. */
  label: string
  /** The alias that matched, if the note was found by one. */
  alias: string | null
  score: number
}

interface Prepared { note: NoteEntry; title: string; name: string; path: string; aliases: string[]; folder: string }

/**
 * The notes of the workspace, ready to be suggested: ranking by what's typed
 * and links that resolve from the current note. Built once per tree fetch.
 */
export class NoteCatalog {
  private readonly prepared: Prepared[]
  private readonly index: LinkIndex
  private readonly collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

  /** `aliases`: whether aliases resolve links (thoth.yaml). Either way they're suggested, and inserted as `[[Note|alias]]`. */
  constructor(notes: readonly NoteEntry[], opts: { aliases?: boolean } = {}) {
    this.index = new LinkIndex({ aliases: opts.aliases ?? true })
    this.prepared = notes.map((note) => ({
      note,
      title: fold(note.title || baseName(note.path)),
      name: fold(baseName(note.path)),
      path: fold(stripMd(note.path)),
      aliases: (note.aliases ?? []).map(fold),
      folder: folderOf(note.path),
    }))
    for (const n of notes) this.index.set({ path: n.path, aliases: n.aliases ?? [] })
  }

  get size() { return this.prepared.length }

  /** Notes that match `query`, best first; notes in the current note's folder win ties. The current note is left out. */
  rank(query: string, source: string, limit = 50): NoteMatch[] {
    const q = fold(query)
    const here = folderOf(source)
    const out: (NoteMatch & { near: number; sort: string })[] = []
    for (const p of this.prepared) {
      if (p.note.path === source) continue
      const label = p.note.title || baseName(p.note.path)
      let best = Math.max(matchScore(p.title, q), matchScore(p.name, q) - 1)
      if (q.includes('/')) best = Math.max(best, matchScore(p.path, q) - 2)
      let alias: string | null = null
      p.aliases.forEach((a, i) => {
        const s = matchScore(a, q) - 3
        if (s > best) { best = s; alias = p.note.aliases![i]! }
      })
      if (best < 0) continue
      out.push({ path: p.note.path, label: alias ?? label, alias, score: best, near: p.folder === here ? 1 : 0, sort: label })
    }
    out.sort((a, b) => b.score - a.score || b.near - a.near || a.sort.length - b.sort.length || this.collator.compare(a.sort, b.sort) || this.collator.compare(a.path, b.path))
    return out.slice(0, limit).map(({ near: _n, sort: _s, ...m }) => m)
  }

  /** The shortest wikilink target that reaches `path` from `source` without ambiguity. */
  linkTarget(source: string, path: string): string {
    return shortestTarget(this.index, source, path)
  }

  /** Where a wikilink target written in `source` leads, or null if it's missing or ambiguous. */
  resolve(source: string, target: string): string | null {
    const r = this.index.resolve(source, { kind: 'wiki', target, anchor: null })
    return r.status === 'resolved' ? r.path : null
  }

  /** Title and aliases of a note: suggestions for a link's visible text. */
  displays(path: string): string[] {
    const n = this.prepared.find((p) => p.note.path === path)?.note
    if (!n) return []
    return [...new Set([n.title || baseName(n.path), ...(n.aliases ?? [])])]
  }
}

/** Headings that match, in the note's order when nothing's typed; best first otherwise. */
export function rankHeadings(headings: readonly HeadingEntry[], query: string): HeadingEntry[] {
  const q = fold(query)
  if (!q) return [...headings]
  return headings
    .map((h, i) => ({ h, i, s: matchScore(fold(h.text), q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.h)
}

/**
 * Tags that match, best first, then the most used. None once what's typed is
 * already a tag: ↵ must end the line, not swap the tag for a longer one.
 */
export function rankTags(tags: readonly TagEntry[], query: string, limit = 50): TagEntry[] {
  const q = fold(query)
  if (q && tags.some((t) => fold(t.tag) === q)) return []
  return tags
    .map((t) => ({ t, s: matchScore(fold(t.tag), q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || b.t.count - a.t.count || a.t.tag.localeCompare(b.t.tag))
    .slice(0, limit)
    .map((x) => x.t)
}

/**
 * Where a completion ends and what closes it. `after` is the line's text after
 * the cursor; `stop` the characters that end the part being completed. If the
 * rest of an old value follows up to one of `]]`, `|` or `#`, it's replaced
 * and nothing is added; otherwise `close` is appended.
 */
export function completionEnd(after: string, stop: RegExp): { extend: number; closed: boolean } {
  const rest = stop.exec(after)?.[0] ?? ''
  const next = after.slice(rest.length)
  if (next.startsWith(']]') || next.startsWith('|') || next.startsWith('#')) return { extend: rest.length, closed: true }
  return { extend: 0, closed: false }
}
