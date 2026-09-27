// The leak scenario (m3 §3, D-014), shared by the HTTP API's leak tests and
// the MCP server's: a key limited to one folder (DIR.key), with a note
// `ai: false` inside it, another with a frontmatter that can't be read, a
// folder holding only a hidden note, and notes outside (DIR.outside) that
// link to the visible one and mention the hidden ones; plus a history with
// something to hide. Every name, text and tag is the mother's, the same for
// every setup of a test file. What gives a hidden note away (MARKERS) is a
// word no generated text can contain (the mother's unique words): folders,
// file names and words that must never reach the key are made of them.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG, type setup } from './_agents.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** The key's folder and the one outside it (a marker: nothing of it may reach the key). */
export const DIR = { key: m.aFolder(), outside: m.aUniqueWord() }
/** Folders inside the key's: two holding a note of the same name, one holding only a hidden note (a marker), the daily notes'. */
export const SUB = { a: m.aFolder(), b: m.aFolder(), onlyHidden: m.aUniqueWord(), daily: m.aFolder(), outsideDaily: m.aFolder() }
/** Note names (without `.md`), as links name them. */
export const NAME = {
  visible: m.aTitle(), secret: m.aTitle(), broken: m.aTitle(), dup: m.aTitle(), onlyHidden: m.aTitle(), revealed: m.aTitle(),
  other: m.aTitle(), otherRenamed: m.aTitle(), moving: m.aTitle(), template: m.aTitle(),
  /** Images: the visible one's, and two only hidden notes show (markers). */
  photo: m.aTitle(), hiddenPhoto: m.aUniqueWord(), outsideImage: m.aUniqueWord(),
}
/** A tag the visible note shares with hidden ones, and one only hidden notes have (a marker). */
export const TAG = { shared: m.aTag(), hidden: m.aUniqueWord() }
/** Words only one note has: the visible one's, and the hidden ones' (markers). */
export const WORD = {
  visible: m.aUniqueWord(), secret: m.aUniqueWord(), broken: m.aUniqueWord(), onlyHidden: m.aUniqueWord(), revealed: m.aUniqueWord(),
  other: m.aUniqueWord(), outsideDup: m.aUniqueWord(), moving: m.aUniqueWord(), template: m.aUniqueWord(),
}
/** The daily series: one in the key's folder (its template outside), one outside. */
export const SERIES = { own: m.anId(), outside: m.anId() }
/** The notes and images of FILES, by what they are. */
export const PATH = {
  visible: `${DIR.key}/${NAME.visible}.md`,
  secret: `${DIR.key}/${NAME.secret}.md`,
  broken: `${DIR.key}/${NAME.broken}.md`,
  dupA: `${DIR.key}/${SUB.a}/${NAME.dup}.md`,
  dupB: `${DIR.key}/${SUB.b}/${NAME.dup}.md`,
  onlyHidden: `${DIR.key}/${SUB.onlyHidden}/${NAME.onlyHidden}.md`,
  revealed: `${DIR.key}/${NAME.revealed}.md`,
  photo: `${DIR.key}/${NAME.photo}.png`,
  hiddenPhoto: `${DIR.key}/${NAME.hiddenPhoto}.png`,
  other: `${DIR.outside}/${NAME.other}.md`,
  /** Where `other` goes (historyToHide), renamed outside. */
  otherRenamed: `${DIR.outside}/${NAME.otherRenamed}.md`,
  outsideDup: `${DIR.outside}/${NAME.dup}.md`,
  moving: `${DIR.outside}/${NAME.moving}.md`,
  /** Where `moving` is brought in (historyToHide). */
  movedIn: `${DIR.key}/${NAME.moving}.md`,
  template: `${DIR.outside}/${NAME.template}.md`,
  outsideImage: `${DIR.outside}/${NAME.outsideImage}.png`,
  /** Today's note of the key's series (the clock of _agents.ts says 2026-09-26). */
  daily: `${DIR.key}/${SUB.daily}/2026-09-26.md`,
}
/** The heading of the note outside: a text that names no note. */
export const OTHER_HEADING = `${m.aHeading()} ${WORD.other}`
/** A Markdown destination for a file name: its spaces written `%20` (a destination can't have spaces). */
const dest = (name: string) => name.replace(/ /g, '%20')
/** What `moving` said outside, and what it says once changed (historyToHide). */
const MOVING_BEFORE = `${WORD.moving} ${m.aSentence()}`
const MOVING_AFTER = m.aSentence()

export const FILES: Record<string, string | Uint8Array> = {
  [PATH.visible]: `---\ntitle: ${JSON.stringify(m.aHeading())}\ntags: [${TAG.shared}]\n---\n# ${m.aHeading()}\n\n${m.aSentence()} [[${NAME.secret}]], [[${NAME.other}]] [[${NAME.dup}]]. ${WORD.visible}.\n\n![](${dest(NAME.photo)}.png)\n`,
  [PATH.secret]: `---\nai: false\ntags: [${TAG.shared}, ${TAG.hidden}]\n---\n# ${m.aHeading()} ${WORD.secret}\n\n${WORD.secret} ${m.aSentence()} [[${NAME.visible}]].\n\n![](${NAME.hiddenPhoto}.png)\n`,
  // A frontmatter that can't be read (an unclosed flow sequence): the case under test.
  [PATH.broken]: `---\ntitle: [${m.aWord()}\n---\n# ${WORD.broken}\n\n${WORD.broken} ${m.aSentence()} [[${NAME.visible}]]\n`,
  [PATH.dupA]: `# ${m.aHeading()}\n`,
  [PATH.dupB]: `# ${m.aHeading()}\n`,
  // `ai: no` hides it too (YAML 1.1's no, as other tools write it).
  [PATH.onlyHidden]: `---\nai: no\n---\n# ${WORD.onlyHidden}\n`,
  [PATH.revealed]: `---\nai: false\n---\n# ${m.aHeading()}\n\n${WORD.revealed} ${m.aSentence()}\n`,
  [PATH.photo]: PNG,
  [PATH.hiddenPhoto]: PNG,
  [PATH.other]: `---\ntags: [${TAG.shared}, ${TAG.hidden}]\n---\n# ${OTHER_HEADING}\n\n${WORD.other}. ${WORD.secret} ${m.aSentence()} [[${NAME.visible}]] [[${NAME.secret}]].\n\n![](${NAME.outsideImage}.png)\n`,
  [PATH.outsideDup]: `# ${m.aHeading()} ${WORD.outsideDup}\n`,
  [PATH.moving]: `# ${m.aHeading()}\n\n${MOVING_BEFORE}\n`,
  [PATH.template]: `# ${m.aHeading()}\n\n${WORD.template} ${m.aSentence()}\n`,
  [PATH.outsideImage]: PNG,
}

export const CONFIG = `daily:
  ${SERIES.own}:
    folder: ${JSON.stringify(`${DIR.key}/${SUB.daily}`)}
    template: ${JSON.stringify(PATH.template.replace(/\.md$/, ''))}
  ${SERIES.outside}:
    folder: ${JSON.stringify(`${DIR.outside}/${SUB.outsideDaily}`)}
`

const both = (w: string) => [w, w.charAt(0).toUpperCase() + w.slice(1)]
/**
 * What must never reach the key: the hidden notes' paths, and the words,
 * tag, folders and images only they have (words in both cases, as a heading
 * could capitalise one); the folder outside and whatever is in it.
 */
export const MARKERS = [
  PATH.secret, ...both(WORD.secret), TAG.hidden, NAME.hiddenPhoto,
  PATH.broken, ...both(WORD.broken),
  SUB.onlyHidden, ...both(WORD.onlyHidden),
  ...both(WORD.revealed),
  DIR.outside, ...both(WORD.other), ...both(WORD.outsideDup), NAME.outsideImage, ...both(WORD.moving), ...both(WORD.template),
]

/**
 * The notes that exist and are hidden from the key, once `historyToHide`
 * has run: a request naming one of them is told so (`agent_denied`).
 */
export const HIDDEN = [PATH.secret, PATH.broken, PATH.onlyHidden, PATH.otherRenamed, PATH.outsideDup, PATH.template]

/** The markers in `shown` that the request (`asked`) didn't name itself. */
export const leaked = (shown: string, asked: string) => MARKERS.filter((mk) => shown.includes(mk) && !asked.includes(mk))

/**
 * A history with something to hide, made by the user: edits to hidden notes
 * and outside, a note that was hidden and isn't any more, one brought in from
 * outside, and a link the system rewrote because a note outside was renamed.
 * Returns the version ids of the notes whose history matters.
 */
export async function historyToHide(h: Awaited<ReturnType<typeof setup>>) {
  const put = async (path: string, edit: (t: string) => string) => {
    const cur = await h.admin('GET', h.url('/api/note', { path }))
    const r = await h.admin('PUT', h.url('/api/note', { path }), { text: edit(cur.body.text) }, { 'if-match': `"${cur.body.etag}"` })
    assert.equal(r.status, 200, `${path}: ${r.text}`)
    await h.settle()
  }
  await put(PATH.secret, (t) => t + `${WORD.secret} ${m.aSentence()}\n`)
  await put(PATH.other, (t) => t + `${WORD.other} ${m.aSentence()}\n`)
  await put(PATH.revealed, () => `---\nai: true\n---\n# ${m.aHeading()}\n\n${m.aSentence()}\n`)
  await put(PATH.visible, (t) => t + `${m.aSentence()}\n`)
  // Written outside, then brought in: what it said outside stays there.
  await put(PATH.moving, (t) => t.replace(MOVING_BEFORE, MOVING_AFTER))
  assert.equal((await h.admin('POST', '/api/note/move', { from: PATH.moving, to: PATH.movedIn })).status, 200)
  // A note outside, renamed: the system rewrites the visible note's link to it.
  assert.equal((await h.admin('POST', '/api/note/move', { from: PATH.other, to: PATH.otherRenamed })).status, 200)
  await h.settle()
  assert.ok(readFileSync(join(h.notesDir, PATH.visible), 'utf8').includes(`[[${NAME.otherRenamed}]]`))
  const idsOf = async (path: string) => ((await h.admin('GET', h.url('/api/history/versions', { path }))).body.versions as { id: string }[]).map((v) => v.id)
  const ids = { secret: await idsOf(PATH.secret), revealed: await idsOf(PATH.revealed), visible: await idsOf(PATH.visible) }
  assert.ok(ids.secret.length >= 2 && ids.revealed.length >= 2 && ids.visible.length >= 2)
  return ids
}
