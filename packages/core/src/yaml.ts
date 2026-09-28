// Parsing YAML that someone else wrote (a note's frontmatter, vihko.yaml), in
// time linear in its size.
import { isMap, isPair, isScalar, isSeq, parseDocument, YAMLParseError, type Document, type LineCounter } from 'yaml'

/**
 * Parses `text` with the YAML 1.2 core schema (no dates or other implicit
 * conversions from YAML 1.1). A key repeated in a map is an error, as yaml's
 * `uniqueKeys` would report it, but found in one pass: yaml compares each key
 * with every earlier key of its map, and a map of a few tens of thousands of
 * keys kept the server busy for minutes.
 */
export function parseYamlDocument(text: string, opts: { lineCounter?: LineCounter } = {}): Document {
  const doc = parseDocument(text, { schema: 'core', uniqueKeys: false, prettyErrors: false, lineCounter: opts.lineCounter })
  if (doc.errors.length === 0) {
    const at = repeatedKey(doc.contents)
    if (at !== null) doc.errors.push(new YAMLParseError([at, at + 1], 'DUPLICATE_KEY', 'Map keys must be unique'))
  }
  return doc
}

/**
 * Offset of the first repeated key (in the text) of any map under `root`;
 * null if there's none. Keys are the same when yaml's own check says so:
 * scalars with the same value (`1` and `1.0` are, `1` and `"1"` aren't).
 * Walked without recursion, so no nesting overflows the stack.
 */
function repeatedKey(root: unknown): number | null {
  let first: number | null = null
  const pending: unknown[] = [root]
  while (pending.length) {
    const node = pending.pop()
    if (isMap(node)) {
      const seen = new Set<unknown>()
      for (const pair of node.items) {
        const key = pair.key
        if (isScalar(key) && !Number.isNaN(key.value)) {
          const at = key.range?.[0] ?? 0
          if (seen.has(key.value) && (first === null || at < first)) first = at
          seen.add(key.value)
        }
        pending.push(pair.key, pair.value)
      }
    } else if (isSeq(node)) {
      for (const item of node.items) pending.push(item)
    } else if (isPair(node)) pending.push(node.key, node.value)
  }
  return first
}
