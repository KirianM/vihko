// YAML frontmatter: locate it, read it and modify a key without
// re-serializing the block. Anything not explicitly touched is preserved
// byte for byte (comments, order, quoting, list style, unknown keys).
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument, stringify, type Document } from 'yaml'

export type Eol = '\n' | '\r\n'

export interface FrontmatterBlock {
  /** The file starts with a BOM (U+FEFF). */
  bom: boolean
  eol: Eol
  /** Offset of the opening `---` line (after the BOM). */
  start: number
  /** Offsets of the YAML between the delimiters. */
  yamlStart: number
  yamlEnd: number
  /** Offset right after the closing line (start of the body). */
  end: number
}

export interface Frontmatter {
  /** null if the note has no frontmatter. */
  block: FrontmatterBlock | null
  /** YAML data; `{}` if there's no frontmatter or it's invalid. */
  data: Record<string, unknown>
  /** Message if the YAML can't be read or isn't a map. A note like that is never written. */
  error: string | null
  /** Offset where the body starts. */
  bodyStart: number
}

export class FrontmatterError extends Error {}

const BOM = '﻿'
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/

export function locateFrontmatter(text: string): FrontmatterBlock | null {
  const bom = text.startsWith(BOM)
  const start = bom ? 1 : 0
  let eol: Eol
  if (text.startsWith('---\r\n', start)) eol = '\r\n'
  else if (text.startsWith('---\n', start)) eol = '\n'
  else return null
  const yamlStart = start + 3 + eol.length
  let lineStart = yamlStart
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (CLOSING.test(line)) {
      return { bom, eol, start, yamlStart, yamlEnd: lineStart, end: nl === -1 ? text.length : nl + 1 }
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
  return null // no closing delimiter: not frontmatter, it's all body
}

function parseYaml(raw: string): { doc: Document; data: Record<string, unknown> } | { error: string } {
  // YAML 1.2 core schema: no dates or other implicit conversions from YAML 1.1.
  const doc = parseDocument(raw, { schema: 'core', uniqueKeys: true, prettyErrors: false })
  if (doc.errors.length) return { error: doc.errors[0]!.message }
  if (doc.contents !== null && !isMap(doc.contents)) return { error: 'the frontmatter is not a map' }
  const data = toData(doc)
  return 'error' in data ? data : { doc, data: (data.value ?? {}) as Record<string, unknown> }
}

/**
 * The document's value. Aliases that would expand past a limit (a "billion
 * laughs" in a note or vihko.yaml) make it throw: that's one more kind of
 * invalid YAML, never an exception for whoever reads the file.
 */
export function toData(doc: Document): { value: unknown } | { error: string } {
  try {
    return { value: doc.toJS({ maxAliasCount: 100 }) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function readFrontmatter(text: string): Frontmatter {
  const block = locateFrontmatter(text)
  if (!block) return { block: null, data: {}, error: null, bodyStart: text.startsWith(BOM) ? 1 : 0 }
  const parsed = parseYaml(text.slice(block.yamlStart, block.yamlEnd))
  if ('error' in parsed) return { block, data: {}, error: parsed.error, bodyStart: block.end }
  return { block, data: parsed.data, error: null, bodyStart: block.end }
}

export type ScalarValue = string | number | boolean

function scalarText(value: ScalarValue): string {
  if (typeof value === 'string' && /[\r\n]/.test(value)) {
    throw new FrontmatterError('a frontmatter patch only accepts single-line values')
  }
  return stringify(value, { lineWidth: 0 }).trimEnd()
}

/** A list of scalars as a one-line flow list (`[a, "b, c"]`), quoted where the flow context needs it. */
function listText(values: readonly ScalarValue[]): string {
  if (values.some((v) => typeof v === 'string' && /[\r\n]/.test(v))) {
    throw new FrontmatterError('a frontmatter patch only accepts single-line values')
  }
  return stringify(values, { lineWidth: 0, collectionStyle: 'flow', flowCollectionPadding: false }).trimEnd()
}

/**
 * Returns `text` with the top-level key `key` set to `value` (a scalar, or a
 * list of them written as a flow list), touching only the bytes of that
 * value (or adding a line, or creating the block). Throws FrontmatterError
 * if the frontmatter is invalid: a note like that is never written.
 */
export function setFrontmatterKey(text: string, key: string, value: ScalarValue | readonly ScalarValue[]): string {
  const out = setFrontmatterKeyRaw(text, key, Array.isArray(value) ? listText(value) : scalarText(value as ScalarValue))
  verifyPatch(text, out, key, value)
  return out
}

/** Sets `key` to `valueText`, which is already single-line YAML. Doesn't verify: that's the caller's job. */
function setFrontmatterKeyRaw(text: string, key: string, valueText: string): string {
  const block = locateFrontmatter(text)
  const keyText = scalarText(key)

  let out: string
  if (!block) {
    const bom = text.startsWith(BOM) ? BOM : ''
    const body = text.slice(bom.length)
    const eol: Eol = /\r\n/.test(body) ? '\r\n' : '\n'
    out = `${bom}---${eol}${keyText}: ${valueText}${eol}---${eol}${body}`
  } else {
    const raw = text.slice(block.yamlStart, block.yamlEnd)
    const parsed = parseYaml(raw)
    if ('error' in parsed) throw new FrontmatterError(`invalid frontmatter: ${parsed.error}`)
    const map = parsed.doc.contents
    const pair = isMap(map) ? map.items.find((p) => isScalar(p.key) && p.key.value === key) : undefined
    let newRaw: string
    if (!pair) {
      newRaw = raw + `${keyText}: ${valueText}${block.eol}`
    } else {
      const keyNode = pair.key as { range?: [number, number, number] }
      const valueNode = pair.value as { range?: [number, number, number] } | null
      const colon = raw.indexOf(':', keyNode.range![1])
      if (!valueNode?.range) {
        // `key:` with no value.
        newRaw = raw.slice(0, colon + 1) + ' ' + valueText + raw.slice(colon + 1)
      } else {
        const [vStart, vEnd] = valueNode.range
        // Block value on the following lines: replace starting from the colon.
        const from = raw.slice(colon + 1, vStart).includes('\n') ? colon + 1 : vStart
        const to = vEnd
        newRaw = raw.slice(0, from) + (from === colon + 1 ? ' ' : '') + valueText + trailingEol(raw, from, to, block.eol) + raw.slice(to)
      }
    }
    out = text.slice(0, block.yamlStart) + newRaw + text.slice(block.yamlEnd)
  }
  return out
}

/** If what was replaced spanned whole lines, keep the trailing newline. */
function trailingEol(raw: string, from: number, to: number, eol: Eol): string {
  const replaced = raw.slice(from, to)
  return replaced.includes('\n') && replaced.endsWith('\n') ? eol : ''
}

/** Safety net: the result must have the requested value and everything else unchanged. */
function verifyPatch(before: string, after: string, key: string, value: ScalarValue | readonly ScalarValue[]) {
  const a = readFrontmatter(before)
  const b = readFrontmatter(after)
  if (b.error) throw new FrontmatterError(`the patch produced invalid YAML: ${b.error}`)
  if (!isDeepStrictEqual(b.data[key], value)) throw new FrontmatterError('the patch did not set the requested value')
  const restA = { ...a.data }
  const restB = { ...b.data }
  delete restA[key]
  delete restB[key]
  if (!isDeepStrictEqual(restA, restB)) throw new FrontmatterError('the patch altered other keys')
  if (before.slice(a.bodyStart) !== after.slice(b.bodyStart)) throw new FrontmatterError('the patch altered the body')
}

/**
 * Adds `item` to the top-level list `key` without re-serializing the block:
 * in a flow list it's inserted before the `]`, in a block list a line is
 * added, a scalar is turned into a flow list, and if the key doesn't exist
 * it's created as `key: [item]`. Does nothing if the item is already there.
 */
export function addToFrontmatterList(text: string, key: string, item: string): string {
  const fm = readFrontmatter(text)
  if (fm.error) throw new FrontmatterError(`invalid frontmatter: ${fm.error}`)
  const current = fm.data[key]
  const list = Array.isArray(current) ? current : current == null ? [] : [current]
  if (list.some((x) => String(x) === item)) return text
  const itemText = scalarText(item)

  let out: string
  const block = fm.block
  const pairRange = block ? findPair(text.slice(block.yamlStart, block.yamlEnd), key) : null
  if (!block || !pairRange) {
    out = setFrontmatterKeyRaw(text, key, `[${itemText}]`)
  } else {
    const raw = text.slice(block.yamlStart, block.yamlEnd)
    const { value, colon } = pairRange
    let newRaw: string
    if (value && value.flow && value.kind === 'seq') {
      const close = raw.lastIndexOf(']', value.end - 1)
      const inner = raw.slice(value.start + 1, close).trim()
      newRaw = raw.slice(0, close) + (inner ? `, ${itemText}` : itemText) + raw.slice(close)
    } else if (value && value.kind === 'seq') {
      // Block list: new line with the same indentation as the first item.
      const lineStart = raw.lastIndexOf('\n', value.start - 1) + 1
      const indent = raw.slice(lineStart, value.start)
      const end = value.end
      const needsEol = end > 0 && raw[end - 1] !== '\n'
      newRaw = raw.slice(0, end) + (needsEol ? block.eol : '') + `${indent}- ${itemText}${block.eol}` + raw.slice(end)
    } else if (value) {
      const old = raw.slice(value.start, value.end).trim()
      newRaw = raw.slice(0, value.start) + `[${old}, ${itemText}]` + raw.slice(value.end)
    } else {
      newRaw = raw.slice(0, colon + 1) + ` [${itemText}]` + raw.slice(colon + 1)
    }
    out = text.slice(0, block.yamlStart) + newRaw + text.slice(block.yamlEnd)
  }

  const after = readFrontmatter(out)
  const rest = (d: Record<string, unknown>) => { const c = { ...d }; delete c[key]; return c }
  if (after.error || !isDeepStrictEqual(after.data[key], [...list, item]) || !isDeepStrictEqual(rest(after.data), rest(fm.data))) {
    throw new FrontmatterError('the list patch did not produce the expected result')
  }
  if (text.slice(fm.bodyStart) !== out.slice(after.bodyStart)) throw new FrontmatterError('the patch altered the body')
  return out
}

function findPair(raw: string, key: string) {
  const parsed = parseYaml(raw)
  if ('error' in parsed) return null
  const map = parsed.doc.contents
  const pair = isMap(map) ? map.items.find((p) => isScalar(p.key) && p.key.value === key) : undefined
  if (!pair) return null
  const keyNode = pair.key as { range: [number, number, number] }
  const colon = raw.indexOf(':', keyNode.range[1])
  const v = pair.value as ({ range?: [number, number, number]; flow?: boolean } & object) | null
  if (!v?.range) return { colon, value: null }
  return { colon, value: { start: v.range[0], end: v.range[1], flow: !!v.flow, kind: isSeq(v) ? 'seq' : 'other' } }
}
