// Where text inserted from a dialog or a command goes (an image, a link, a
// tag, a comment…): never inside the syntax of a link, an image, a comment or
// another inline construct, which it would break. The cursor can be inside
// one while its syntax is hidden (the source is revealed around it), or
// everything may have moved while an image uploaded.
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

/** Inline nodes nothing is inserted into: an insertion point inside one goes to its end. */
export const INLINE = new Set(['Link', 'Image', 'WikiLink', 'WikiEmbed', 'InlineCode', 'Autolink', 'URL', 'Tag', 'Comment', 'HTMLTag'])

/** `pos`, or the end of the inline node it falls inside (the outermost, with one inside another). */
export function outsideInline(state: EditorState, pos: number): number {
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state)
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = tree.resolveInner(pos, -1); n; n = n.parent) {
    if (INLINE.has(n.name) && n.from < pos && pos < n.to) pos = n.to
  }
  return pos
}

/**
 * The range to insert over, for `from`–`to` (the selection, or where an image
 * was asked for): the same if neither end is inside an inline node; if one
 * is, nothing is replaced, and the text goes right after that node.
 */
export function insertionRange(state: EditorState, from: number, to: number): { from: number; to: number } {
  const a = outsideInline(state, from)
  const b = outsideInline(state, to)
  if (a === from && b === to) return { from, to }
  // After the node the range ends in, or else the one it starts in.
  const at = b !== to ? b : a
  return { from: at, to: at }
}
