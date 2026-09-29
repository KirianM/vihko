import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { vihkoSyntax } from '@vihko/core/syntax'
import { activeFormats, insertLink, insertTable, toggleCodeBlock, toggleHeading, toggleInline, toggleList, toggleQuote } from '../src/editor/format.ts'
import { mother } from '../../../test/mother.ts'

// The Markdown each action writes is the case under test, so it is written out
// literally; the words around it come from the mother.
const m = mother(import.meta.url)
/** Words long enough to put a cursor inside (two words run together). */
const w = () => m.aUniqueWord()

// As the editor parses it (Editor.tsx).
const language = yamlFrontmatter({ content: markdown({ base: markdownLanguage, extensions: vihkoSyntax }) })

/** `doc` with `‸` for the cursor or `«…»` for a selection. */
function state(doc: string): EditorState {
  const cursor = doc.indexOf('‸')
  const open = doc.indexOf('«')
  if (cursor >= 0) return EditorState.create({ doc: doc.replace('‸', ''), selection: { anchor: cursor }, extensions: language })
  if (open >= 0) {
    const close = doc.indexOf('»') - 1
    return EditorState.create({ doc: doc.replace('«', '').replace('»', ''), selection: { anchor: open, head: close }, extensions: language })
  }
  return EditorState.create({ doc, extensions: language })
}

/** The text after the change, with the selection marked the same way; null if nothing changes. */
function run(doc: string, action: (s: EditorState) => TransactionSpec | null): string | null {
  const before = state(doc)
  const spec = action(before)
  if (!spec) return null
  const after = before.update(spec).state
  const text = after.doc.toString()
  const { from, to } = after.selection.main
  return from === to ? `${text.slice(0, from)}‸${text.slice(from)}` : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
}

const bold = (s: EditorState) => toggleInline(s, 'strong')
const italic = (s: EditorState) => toggleInline(s, 'em')
const strike = (s: EditorState) => toggleInline(s, 'strike')
const code = (s: EditorState) => toggleInline(s, 'code')
const h = (level: number) => (s: EditorState) => toggleHeading(s, level)
const list = (kind: 'bullet' | 'ordered' | 'task') => (s: EditorState) => toggleList(s, kind)
const table = (s: EditorState) => insertTable(s, (n) => `C${n}`)

test('inline marks wrap the selection, keeping it on the same text, and come off inside one', () => {
  const [a, b, c] = [w(), w(), w()]
  assert.equal(run(`${a} «${b}» ${c}`, bold), `${a} **«${b}»** ${c}`)
  assert.equal(run(`${a} «${b}» ${c}`, italic), `${a} *«${b}»* ${c}`)
  assert.equal(run(`${a} «${b}» ${c}`, strike), `${a} ~~«${b}»~~ ${c}`)
  assert.equal(run(`${a} «${b}» ${c}`, code), `${a} \`«${b}»\` ${c}`)
  // Off: the cursor anywhere inside, the text inside selected, or the whole of it with its markers.
  assert.equal(run(`${a} **${b.slice(0, 2)}‸${b.slice(2)}** ${c}`, bold), `${a} ${b.slice(0, 2)}‸${b.slice(2)} ${c}`)
  assert.equal(run(`${a} **«${b}»** ${c}`, bold), `${a} «${b}» ${c}`)
  assert.equal(run(`${a} «**${b}**» ${c}`, bold), `${a} «${b}» ${c}`)
  assert.equal(run(`${a} _${b}‸_ ${c}`, italic), `${a} ${b}‸ ${c}`)
  assert.equal(run(`${a} ~~‸${b}~~`, strike), `${a} ‸${b}`)
  assert.equal(run(`\`${b.slice(0, 1)}‸${b.slice(1)}\``, code), `${b.slice(0, 1)}‸${b.slice(1)}`)
})

test('inline marks: an empty cursor takes the word it is in, or leaves the markers to type between', () => {
  const [a, b] = [w(), w()]
  assert.equal(run(`${a} ${b.slice(0, 2)}‸${b.slice(2)}.`, bold), `${a} **${b.slice(0, 2)}‸${b.slice(2)}**.`)
  assert.equal(run(`${a} ‸`, bold), `${a} **‸**`)
  // Pressed again with nothing typed: they go.
  assert.equal(run(`${a} **‸**`, bold), `${a} ‸`)
  assert.equal(run(`${a} *‸*`, italic), `${a} ‸`)
  // `**‸**` is an empty bold, not two italics: italic goes inside it.
  assert.equal(run(`${a} **‸**`, italic), `${a} ***‸***`)
  // At the very start and end of the text.
  assert.equal(run('‸', bold), '**‸**')
  assert.equal(run(`«${a}»`, bold), `**«${a}»**`)
  // At a word's edge the cursor isn't in it: `*` works inside a word, so what's typed there is italic.
  assert.equal(run(`${a}‸`, italic), `${a}*‸*`)
})

test('inline marks: spaces stay outside, and each line of a range is wrapped on its own after its markers', () => {
  const [a, b, c] = [w(), w(), w()]
  assert.equal(run(`${a}« ${b} »${c}`, bold)?.replace(/[«»]/g, ''), `${a} **${b}** ${c}`)
  assert.equal(run(`- «${a}\n- ${b}»`, bold), `- **«${a}**\n- **${b}»**`)
  assert.equal(run(`# «${a}\n\n> ${b}»\n`, italic), `# *«${a}*\n\n> *${b}»*\n`)
  assert.equal(run(`- [ ] «${a}»`, strike), `- [ ] ~~«${a}»~~`)
  // Only spaces selected: nothing to wrap.
  assert.equal(run(`${a}« »${b}`, bold), null)
})

test('inline marks: the same mark inside the range is merged, and a mark or link cut in two is taken in whole', () => {
  const [a, b, c] = [w(), w(), w()]
  assert.equal(run(`«${a} **${b}** ${c}»`, bold)?.replace(/[«»]/g, ''), `**${a} ${b} ${c}**`)
  assert.equal(run(`«${a} **${b}»${c}**`, bold)?.replace(/[«»]/g, ''), `**${a} ${b}${c}**`)
  assert.equal(run(`«${a} *${b}»${c}* x`, bold)?.replace(/[«»]/g, ''), `**${a} *${b}${c}*** x`)
  // A Markdown link: in its text it stays a link; cut, the whole link.
  assert.equal(run(`[«${a}»](${b}.md)`, bold), `[**«${a}»**](${b}.md)`)
  assert.equal(run(`${c} «${a} [${b}»](x.md) ${c}`, bold)?.replace(/[«»]/g, ''), `${c} **${a} [${b}](x.md)** ${c}`)
  // A wikilink, a tag or inline code are never split: the cursor in one takes it whole.
  assert.equal(run(`${c} [[${a.slice(0, 2)}‸${a.slice(2)}]] ${c}`, bold)?.replace('‸', ''), `${c} **[[${a}]]** ${c}`)
  assert.equal(run(`${c} #${a.slice(0, 2)}‸${a.slice(2)} ${c}`, italic)?.replace('‸', ''), `${c} *#${a}* ${c}`)
  assert.equal(run(`\`${a}\` ${b.slice(0, 2)}‸${b.slice(2)}`, bold)?.replace('‸', ''), `\`${a}\` **${b}**`)
  // In a bold word, italic goes on the word inside it.
  assert.equal(run(`**${a} ${b.slice(0, 2)}‸${b.slice(2)} ${c}**`, italic)?.replace('‸', ''), `**${a} *${b}* ${c}**`)
})

test('inline code: a longer fence around backticks, padded when they touch it; off, the padding goes too', () => {
  assert.equal(run('«a`b»', code), '``«a`b»``')
  assert.equal(run('«`a»', code)?.replace(/[«»]/g, ''), '`` `a ``')
  assert.equal(run('`` `a‸ ``', code), '`a‸')
})

test('no inline marks inside code blocks or the frontmatter', () => {
  const a = w()
  assert.equal(run(`\`\`\`\n${a}‸\n\`\`\`\n`, bold), null)
  assert.equal(run(`---\ntitle: ${a}‸\n---\n`, italic), null)
  assert.equal(run(`    ${a}‸\n`, code), null)
})

test('link: the selection is its text and the cursor goes where the URL goes', () => {
  const [a, b] = [w(), w()]
  assert.equal(run(`${a} «${b}» ${a}`, insertLink), `${a} [${b}](‸) ${a}`)
  assert.equal(run(`${a} ‸`, insertLink), `${a} [‸]()`)
  assert.equal(run(`${a} ${b.slice(0, 2)}‸${b.slice(2)}.`, insertLink), `${a} [${b}](‸).`)
  assert.equal(run('‸', insertLink), '[‸]()')
  // A selected URL is the destination; the cursor goes to the text.
  assert.equal(run(`${a} «https://example.org/${b}»`, insertLink), `${a} [‸](https://example.org/${b})`)
  // In a link already: its URL, selected to change it.
  assert.equal(run(`[${a.slice(0, 2)}‸${a.slice(2)}](${b}.md)`, insertLink), `[${a}](«${b}.md»)`)
  // Never inside a wikilink: after it.
  assert.equal(run(`[[${a.slice(0, 2)}‸${a.slice(2)}]] ${b}`, insertLink), `[[${a}]][‸]() ${b}`)
  assert.equal(run(`\`\`\`\n${a}‸\n\`\`\``, insertLink), null)
})

test('headings: on every selected line, off when all have that level, another level replaces it', () => {
  const [a, b] = [w(), w()]
  assert.equal(run(`${a}‸`, h(1)), `# ${a}‸`)
  assert.equal(run(`‸${a}`, h(2)), `## ‸${a}`)
  assert.equal(run(`# ${a}‸`, h(1)), `${a}‸`)
  assert.equal(run(`# ${a}‸`, h(3)), `### ${a}‸`)
  assert.equal(run(`### ${a}‸`, h(0)), `${a}‸`)
  assert.equal(run(`${a}‸`, h(0)), null)
  // Blank lines in a range of several stay blank.
  assert.equal(run(`«${a}\n\n${b}»`, h(2)), `## «${a}\n\n## ${b}»`)
  assert.equal(run(`«# ${a}\n${b}»`, h(1)), `«# ${a}\n# ${b}»`)
  assert.equal(run(`«# ${a}\n# ${b}»`, h(1)), `«${a}\n${b}»`)
  // An empty line (or text), ready to type.
  assert.equal(run('‸', h(1)), '# ‸')
  assert.equal(run(`${a}\n‸`, h(3)), `${a}\n### ‸`)
})

test('headings: a list item becomes the heading, a quote keeps its marker, a Setext heading loses its underline', () => {
  const a = w()
  assert.equal(run(`- ${a}‸`, h(1)), `# ${a}‸`)
  assert.equal(run(`  - [ ] ${a}‸`, h(2)), `## ${a}‸`)
  assert.equal(run(`> ${a}‸`, h(2)), `> ## ${a}‸`)
  assert.equal(run(`> # ${a}‸`, h(1)), `> ${a}‸`)
  assert.equal(run(`${a}‸\n===\n`, h(2)), `## ${a}‸\n`)
  assert.equal(run(`${a}‸\n---\n`, h(0)), `${a}‸\n`)
  assert.equal(run(`${a}‸\n---\n`, h(2)), `${a}‸\n`, 'an underline of dashes is a heading 2 already')
  assert.equal(run(`${a}‸\n---\n`, h(1)), `# ${a}‸\n`)
  // Not in code or a table.
  assert.equal(run(`\`\`\`\n${a}‸\n\`\`\``, h(1)), null)
  assert.equal(run(`| x | y |\n| - | - |\n| ${a}‸ | z |`, h(1)), null)
})

test('lists: on and off, on every non-blank line of the range, another kind replaces the marker', () => {
  const [a, b, c] = [w(), w(), w()]
  assert.equal(run(`${a}‸`, list('bullet')), `- ${a}‸`)
  assert.equal(run(`- ${a}‸`, list('bullet')), `${a}‸`)
  assert.equal(run('‸', list('bullet')), '- ‸')
  // A selection from the start of a line stays on its text, after the new marker.
  assert.equal(run(`«${a}\n\n${b}»`, list('bullet')), `- «${a}\n\n- ${b}»`)
  assert.equal(run(`«- ${a}\n${b}»`, list('bullet')), `«- ${a}\n- ${b}»`)
  assert.equal(run(`«- ${a}\n- ${b}»`, list('bullet')), `«${a}\n${b}»`)
  // Another kind: the marker is replaced.
  assert.equal(run(`«- ${a}\n* ${b}»`, list('ordered')), `«1. ${a}\n2. ${b}»`)
  assert.equal(run(`«1. ${a}\n2. ${b}»`, list('bullet')), `«- ${a}\n- ${b}»`)
  assert.equal(run(`- ${a}‸`, list('task')), `- [ ] ${a}‸`)
  assert.equal(run(`- [x] ${a}‸`, list('bullet')), `- ${a}‸`)
  assert.equal(run(`- [x] ${a}‸`, list('task')), `${a}‸`)
  assert.equal(run(`1. ${a}‸`, list('task')), `- [ ] ${a}‸`)
  assert.equal(run(`«- [ ] ${a}\n- [x] ${b}\n${c}»`, list('task')), `«- [ ] ${a}\n- [x] ${b}\n- [ ] ${c}»`)
  // A heading becomes the item; indentation and quotes stay.
  assert.equal(run(`## ${a}‸`, list('bullet')), `- ${a}‸`)
  assert.equal(run(`- ${a}\n  ${b}‸`, list('bullet')), `- ${a}\n  - ${b}‸`)
  assert.equal(run(`> ${a}‸`, list('ordered')), `> 1. ${a}‸`)
  assert.equal(run(`- ${a}\n  - ${b}‸`, list('bullet')), `- ${a}\n\n  ${b}‸`)
  // Not in code.
  assert.equal(run(`\`\`\`\n${a}‸\n\`\`\``, list('bullet')), null)
})

test('numbered lists number correctly: from 1, continuing the list above, and the items after', () => {
  const [a, b, c, d] = [w(), w(), w(), w()]
  assert.equal(run(`«${a}\n${b}\n${c}»`, list('ordered')), `1. «${a}\n2. ${b}\n3. ${c}»`)
  assert.equal(run(`«${a}\n\n${b}»`, list('ordered')), `1. «${a}\n\n2. ${b}»`)
  assert.equal(run(`1. ${a}\n2. ${b}\n${c}‸`, list('ordered')), `1. ${a}\n2. ${b}\n3. ${c}‸`)
  assert.equal(run(`${d}‸\n1. ${a}\n2. ${b}`, list('ordered')), `1. ${d}‸\n2. ${a}\n3. ${b}`)
  assert.equal(run(`1. ${a}\n- ${b}‸\n3. ${c}`, list('ordered')), `1. ${a}\n2. ${b}‸\n3. ${c}`)
  // Starting elsewhere, it keeps its start.
  assert.equal(run(`4. ${a}\n${b}‸`, list('ordered')), `4. ${a}\n5. ${b}‸`)
  // Taken out of the middle: a paragraph of its own, and the rest a list from 1.
  assert.equal(run(`1. ${a}\n2. ‸${b}\n3. ${c}\n4. ${d}`, list('ordered')), `1. ${a}\n\n‸${b}\n1. ${c}\n2. ${d}`)
  assert.equal(run(`- ${a}\n- ‸${b}\n- ${c}`, list('bullet')), `- ${a}\n\n‸${b}\n- ${c}`)
  assert.equal(run(`1. ‸${a}\n2. ${b}`, list('ordered')), `‸${a}\n1. ${b}`)
})

test('quotes: every line (blank ones too), off one level when all are quoted', () => {
  const [a, b, c] = [w(), w(), w()]
  assert.equal(run(`${a}‸`, toggleQuote), `> ${a}‸`)
  assert.equal(run(`> ${a}‸`, toggleQuote), `${a}‸`)
  assert.equal(run('‸', toggleQuote), '> ‸')
  assert.equal(run(`«${a}\n\n${b}»`, toggleQuote), `> «${a}\n>\n> ${b}»`)
  assert.equal(run(`«> ${a}\n>\n> ${b}»`, toggleQuote), `«${a}\n\n${b}»`)
  assert.equal(run(`> > ${a}‸`, toggleQuote), `> ${a}‸`)
  assert.equal(run(`- ${a}‸`, toggleQuote), `> - ${a}‸`)
  // Out of the middle of a quote: its own paragraph, not a lazy line of the quote.
  assert.equal(run(`> ${a}\n> ‸${b}\n> ${c}`, toggleQuote), `> ${a}\n\n‸${b}\n> ${c}`)
  assert.equal(run(`---\ntitle: ${a}‸\n---\n`, toggleQuote), null)
})

test('code blocks: an empty one on a blank line, around the selected lines, and off inside one', () => {
  const [a, b] = [w(), w()]
  assert.equal(run('‸', toggleCodeBlock), '```\n‸\n```')
  assert.equal(run(`${a}\n‸\n${b}`, toggleCodeBlock), `${a}\n\`\`\`\n‸\n\`\`\`\n${b}`)
  assert.equal(run(`${a}‸`, toggleCodeBlock), `\`\`\`\n${a}‸\n\`\`\``)
  assert.equal(run(`‸${a}`, toggleCodeBlock), `\`\`\`\n‸${a}\n\`\`\``)
  assert.equal(run(`«${a}\n${b}»\n`, toggleCodeBlock), `\`\`\`\n«${a}\n${b}»\n\`\`\`\n`)
  assert.equal(run(`> ${a}‸`, toggleCodeBlock), `> \`\`\`\n> ${a}‸\n> \`\`\``)
  // Off: the fences go, the text stays.
  assert.equal(run(`\`\`\`js\n${a}‸\n${b}\n\`\`\`\n`, toggleCodeBlock), `${a}‸\n${b}\n`)
  assert.equal(run(`${a}\n\`\`\`\n‸${b}\n\`\`\``, toggleCodeBlock), `${a}\n‸${b}`)
})

test('table: a GFM skeleton on its own lines, with its first header selected', () => {
  const [a, b] = [w(), w()]
  const T = '| «C1» | C2 |\n| --- | --- |\n|  |  |'
  assert.equal(run('‸', table), T)
  assert.equal(run(`${a}‸`, table), `${a}\n\n${T}`)
  assert.equal(run(`${a}‸\n${b}`, table), `${a}\n\n${T}\n\n${b}`)
  assert.equal(run(`${a}\n‸\n${b}`, table), `${a}\n\n${T}\n\n${b}`)
  assert.equal(run(`${a}\n\n‸\n\n${b}`, table), `${a}\n\n${T}\n\n${b}`)
  assert.equal(run(`> ${a}‸`, table), `> ${a}\n>\n${T.split('\n').map((l) => `> ${l}`).join('\n')}`)
  // Inside a table: after it.
  assert.equal(run(`| x | y |\n| - | - |\n| ${a}‸ | z |\n`, table), `| x | y |\n| - | - |\n| ${a} | z |\n\n${T}\n`)
  assert.equal(run(`\`\`\`\n‸\n\`\`\``, table), null)
})

test('the formats that are on where the selection is', () => {
  const [a, b] = [w(), w()]
  const on = (doc: string) => {
    const x = activeFormats(state(doc))
    return Object.entries(x).filter(([, v]) => v).map(([k, v]) => (typeof v === 'number' ? `${k}${v}` : k)).sort().join(' ')
  }
  assert.equal(on(`${a}‸`), '')
  assert.equal(on(`**${a.slice(0, 1)}‸${a.slice(1)}**`), 'strong')
  assert.equal(on(`**${a}**‸ ${b}`), '')
  assert.equal(on(`**‸**`), 'strong')
  assert.equal(on(`***${a.slice(0, 1)}‸${a.slice(1)}***`), 'em strong')
  assert.equal(on(`~~\`${a.slice(0, 1)}‸${a.slice(1)}\`~~`), 'code strike')
  assert.equal(on(`## ${a}‸`), 'heading2')
  assert.equal(on(`${a}‸\n===`), 'heading1')
  assert.equal(on(`«# ${a}\n## ${b}»`), '')
  assert.equal(on(`- ${a}‸`), 'bullet')
  assert.equal(on(`3. ${a}‸`), 'ordered')
  assert.equal(on(`- [ ] ${a}‸`), 'task')
  assert.equal(on(`«- ${a}\n\n- ${b}»`), 'bullet')
  assert.equal(on(`«- ${a}\n${b}»`), '')
  assert.equal(on(`> - *${a.slice(0, 1)}‸${a.slice(1)}*`), 'bullet em quote')
  assert.equal(on(`\`\`\`\n${a}‸\n\`\`\``), 'codeBlock')
})
