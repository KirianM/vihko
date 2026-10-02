// Templates: a plain `.md` note whose text is copied into a new note, with a
// fixed set of variables filled in. Never any code: a template can't run
// anything, loop or read other notes.
//
// A note is a template when its frontmatter says `template: true`, wherever
// it is: no folder makes one. The new note gets the template's frontmatter
// (`type: decision`, its tags…) without that mark, so it isn't a template
// in turn, and without its aliases: the template's other names would be
// every new note's too, and links by them would lead nowhere certain.
import { formatDate, type CivilDateTime } from './dates.ts'
import { FrontmatterError, readFrontmatter, removeFrontmatterKey, setFrontmatterKey } from './frontmatter.ts'

/** The frontmatter key that marks a note as a template (`template: true`). */
export const TEMPLATE_KEY = 'template'

/** Whether a note's frontmatter data marks it as a template: `template: true`, a YAML true, nothing else. */
export const isTemplate = (data: Record<string, unknown>) => data[TEMPLATE_KEY] === true

/**
 * `text` marked as a template (`on`: `template: true`, the block created if
 * there's none) or without the mark (the key goes), every other byte as it
 * is. Already so: `text` itself. null if its frontmatter can't be read (a
 * note like that is never written).
 */
export function templateMarked(text: string, on: boolean): string | null {
  const fm = readFrontmatter(text)
  if (fm.error) return null
  if (on === isTemplate(fm.data) && (on || !(TEMPLATE_KEY in fm.data))) return text
  try {
    return on ? setFrontmatterKey(text, TEMPLATE_KEY, true) : removeFrontmatterKey(text, TEMPLATE_KEY)
  } catch (err) {
    if (err instanceof FrontmatterError) return null
    throw err
  }
}

/** The keys a note made from a template doesn't take from it: its mark, and its aliases. */
export const TEMPLATE_DROPPED_KEYS = [TEMPLATE_KEY, 'aliases'] as const

/**
 * A template's text as a new note starts from it: without its mark
 * (TEMPLATE_KEY) and its `aliases`, every other byte as it is (its other
 * keys in their order, `ai` included, comments, quoting). A frontmatter that
 * can't be read is left as it is (such a note isn't a template anyway).
 */
export function templateCopy(text: string): string {
  let out = text
  for (const key of TEMPLATE_DROPPED_KEYS) {
    try {
      out = removeFrontmatterKey(out, key)
    } catch (err) {
      if (!(err instanceof FrontmatterError)) throw err
    }
  }
  return out
}

export interface TemplateVars {
  /** Now, in the timezone of the person creating the note. */
  now: CivilDateTime
  /** Name of the person creating the note. */
  user: string
  /** Title of the new note: its file name without `.md`. */
  title: string
}

/** Format of a bare `{{date}}`. */
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD'

/**
 * Fills in `{{date}}`, `{{date:FORMAT}}` (tokens in `formatDate`), `{{user}}`
 * and `{{title}}`. Spaces just inside the braces are allowed. Anything else
 * in `{{…}}` is left as is, and the values put in are never expanded again (a
 * title that contains `{{date}}` stays literal).
 */
export function renderTemplate(text: string, vars: TemplateVars): string {
  // The format is taken whole, never given back a character at a time (`(?=(…))\2`
  // holds what it took): a lazy `[^{}]*?` before `\s*}}` went over every space of
  // a long run again from each of them, in quadratic time.
  return text.replace(/\{\{\s*([A-Za-z]+)(?::(?=([^{}]*))\2)?\s*\}\}/g, (whole, name: string, taken: string | undefined) => {
    const format = taken?.trimEnd()
    switch (name) {
      case 'date': return formatDate(format === undefined ? DEFAULT_DATE_FORMAT : format, vars.now)
      case 'user': return format === undefined ? vars.user : whole
      case 'title': return format === undefined ? vars.title : whole
      default: return whole
    }
  })
}
