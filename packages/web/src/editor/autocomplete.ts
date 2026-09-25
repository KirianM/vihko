// Editor autocomplete: `[[` suggests notes (by title, file name and aliases),
// `[[note#` its headings, `[[note|` its title and aliases as the visible text,
// and `#` the tags already in use. The inserted link is the shortest one that
// resolves to the chosen note from this one (D-019). Data comes from the index
// (tree, tags, headings), cached for a few seconds and refreshed in the
// background, so typing never waits on the network after the first time.
import { acceptCompletion, autocompletion, pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { Prec, type EditorState } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { api } from '../api.ts'
import {
  NoteCatalog, completionContext, completionEnd, fold, folderOf, matchScore, rankHeadings, rankTags,
  type HeadingEntry, type TagEntry,
} from './suggest.ts'

export interface AutocompleteText {
  /** Detail of a tag suggestion: how many notes use it. */
  tagCount: (n: number) => string
}

const TTL_MS = 10_000

/** A value loaded from the server: served from memory, refreshed in the background once stale. */
class Cached<T> {
  private value: T | null = null
  private at = 0
  private pending: Promise<T> | null = null
  private readonly load: () => Promise<T>
  constructor(load: () => Promise<T>) { this.load = load }
  get(): Promise<T> {
    if (Date.now() - this.at > TTL_MS && !this.pending) {
      const p = this.load().then(
        (v) => { this.value = v; this.at = Date.now(); this.pending = null; return v },
        (e: unknown) => { this.pending = null; throw e },
      )
      this.pending = p
      if (this.value !== null) p.catch(() => {})
    }
    return this.value !== null ? Promise.resolve(this.value) : this.pending!
  }
  forget() { this.at = 0 }
}

const notes = new Cached(() => api.tree().then((r) => new NoteCatalog(r.notes)))
const tags = new Cached<TagEntry[]>(() => api.tags())
const headings = new Map<string, Cached<HeadingEntry[]>>()
const headingsOf = (path: string) => {
  let c = headings.get(path)
  if (!c) headings.set(path, (c = new Cached(() => api.headings(path))))
  return c.get()
}

/** The workspace changed from here (a note created): the next suggestions ask the server again. */
export function forgetSuggestions() {
  notes.forget()
  tags.forget()
  headings.clear()
}

// Where nothing is suggested: code, the frontmatter, HTML (thoth's comments) and URLs.
const QUIET = new Set(['InlineCode', 'CodeText', 'FencedCode', 'CodeBlock', 'Frontmatter', 'Comment', 'CommentBlock', 'HTMLBlock', 'HTMLTag', 'URL', 'Autolink'])
function quiet(state: EditorState, pos: number) {
  for (let n: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent as typeof n) {
    if (QUIET.has(n.name)) return true
  }
  return false
}

/** Headings of the note being edited, from its text (it may not be saved yet). */
function ownHeadings(state: EditorState): HeadingEntry[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)
  const out: HeadingEntry[] = []
  tree.iterate({
    enter: (n) => {
      const m = /^(ATX|Setext)Heading(\d)$/.exec(n.name)
      if (!m) return
      const text = m[1] === 'ATX'
        ? state.doc.sliceString(n.from, n.to).replace(/^#+[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()
        : state.doc.lineAt(n.from).text.trim()
      if (text) out.push({ level: Number(m[2]), text })
      return false
    },
  })
  return out
}

const folderLabel = (path: string) => folderOf(path).split('/').filter(Boolean).join(' / ')

/**
 * Inserts `text` over `from`–`to` inside a `[[…]]`: if the old rest of that
 * part runs up to `]]`, `|` or `#`, it's replaced and the cursor goes after the
 * link (or before `|`/`#`); otherwise the link is closed with `]]`.
 */
function insertInLink(view: EditorView, completion: Completion, from: number, to: number, text: string, stop: RegExp, suffix = '') {
  const line = view.state.doc.lineAt(to)
  const after = line.text.slice(to - line.from)
  const end = completionEnd(after, stop)
  const closesHere = end.closed && after.slice(end.extend).startsWith(']]')
  const insert = end.closed ? text + (closesHere ? suffix : '') : `${text}${suffix}]]`
  const cursor = from + insert.length + (closesHere ? 2 : 0)
  view.dispatch({
    changes: { from, to: to + end.extend, insert },
    selection: { anchor: cursor },
    scrollIntoView: true,
    userEvent: 'input.complete',
    annotations: pickedCompletion.of(completion),
  })
}

export function linkAutocomplete(note: string, text: AutocompleteText) {
  async function source(ctx: CompletionContext): Promise<CompletionResult | null> {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const c = completionContext(line.text.slice(0, ctx.pos - line.from))
    if (!c || quiet(ctx.state, ctx.pos)) return null
    const from = ctx.pos - c.query.length

    if (c.kind === 'tag') {
      const list = await tags.get().catch(() => null)
      if (!list || ctx.aborted) return null
      const options = rankTags(list, c.query).map((t): Completion => ({
        label: `#${t.tag}`,
        detail: text.tagCount(t.count),
        type: 'tag',
        apply: (view, completion, f, to) => {
          const rest = /^[\p{L}\p{N}_\-/]*/u.exec(view.state.doc.sliceString(to, view.state.doc.lineAt(to).to))![0]
          view.dispatch({
            changes: { from: f, to: to + rest.length, insert: t.tag },
            selection: { anchor: f + t.tag.length },
            userEvent: 'input.complete',
            annotations: pickedCompletion.of(completion),
          })
        },
      }))
      return options.length ? { from, options, filter: false } : null
    }

    const catalog = await notes.get().catch(() => null)
    if (!catalog || ctx.aborted) return null

    if (c.kind === 'note') {
      const options = catalog.rank(c.query, note).map((m): Completion => {
        const folder = folderLabel(m.path)
        const title = catalog.displays(m.path)[0] ?? ''
        return {
          label: m.label,
          detail: m.alias ? `→ ${title}${folder ? ` · ${folder}` : ''}` : folder,
          type: 'note',
          apply: (view, completion, f, to) =>
            insertInLink(view, completion, f, to, catalog.linkTarget(note, m.path), /^[^[\]|#\n]*/, m.alias ? `|${m.alias}` : ''),
        }
      })
      return options.length ? { from, options, filter: false } : null
    }

    // `[[#…` is a heading of this same note; otherwise, of the note the target resolves to.
    const path = c.target === '' ? note : catalog.resolve(note, c.target)
    if (!path) return null

    if (c.kind === 'heading') {
      const list = path === note ? ownHeadings(ctx.state) : await headingsOf(path).catch(() => null)
      if (!list || ctx.aborted) return null
      const options = rankHeadings(list, c.query).map((h): Completion => ({
        label: h.text,
        detail: `H${h.level}`,
        type: 'heading',
        apply: (view, completion, f, to) => insertInLink(view, completion, f, to, h.text, /^[^[\]|\n]*/),
      }))
      return options.length ? { from, options, filter: false } : null
    }

    const q = fold(c.query)
    const options = catalog.displays(path)
      .filter((d) => matchScore(fold(d), q) >= 0)
      .map((d): Completion => ({
        label: d,
        type: 'text',
        apply: (view, completion, f, to) => insertInLink(view, completion, f, to, d, /^[^[\]\n]*/),
      }))
    return options.length ? { from, options, filter: false } : null
  }

  // Warm up: by the time `[[` is typed, the notes are usually here.
  notes.get().catch(() => {})
  return [
    autocompletion({
      override: [source],
      icons: false,
      maxRenderedOptions: 50,
      tooltipClass: () => 'thoth-complete',
    }),
    // Tab also accepts, as in most editors; with no list open it indents as usual.
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
  ]
}
