// What an agent reads of the files that aren't notes (images): only one a
// note it can read uses, and never one a note hidden from agents uses
// (`ai: false` in the note or in its folder, D-035): writing a note that
// links to such an image doesn't open it. Its user, as always, by the
// folder's permission. The M4 scenario (_m4.ts), with a member's key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { historyFor } from '@vihko/server'
import { DIR, FILES, PATH, PNG, TAG, home, setup, MEMBER } from './_m4.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** An image destination for a note at `from` (a space is written %20: a destination with one isn't an image). */
const dest = (from: string, image: string) => posix.relative(posix.dirname(from), image).replaceAll(' ', '%20')

/** An image only the member's diary uses (its folder is closed to agents), next to the member's notes. */
const DIARY_IMAGE = `${home(MEMBER.username)}/${m.aFolder()}.png`
/** A note in the shared folder with `ai: false`, and the image only it uses, next to it. */
const HIDDEN = `${DIR.shared}/${m.aTitle()}.md`
const HIDDEN_IMAGE = `${DIR.shared}/${m.aFolder()}.png`

const files = {
  ...FILES,
  [PATH.diary]: `${FILES[PATH.diary]}\n![](${dest(PATH.diary, DIARY_IMAGE)})\n`,
  [DIARY_IMAGE]: PNG,
  [HIDDEN]: `---\nai: false\ntags: [${TAG.home}]\n---\n# ${m.aHeading()}\n\n${m.aSentence()}\n\n![](${dest(HIDDEN, HIDDEN_IMAGE)})\n`,
  [HIDDEN_IMAGE]: PNG,
}

test('an agent that writes a note linking to an image of a note hidden from agents still can\'t read it', async () => {
  const h = await setup({ files })
  try {
    await h.enable()
    const agent = h.withKey((await h.newKey('member', { name: m.aKeyName(), canWrite: true })).token)
    const file = (path: string) => h.url('/api/file', { path })
    for (const image of [DIARY_IMAGE, HIDDEN_IMAGE]) {
      assert.equal((await h.member('GET', file(image))).status, 200, 'its user reads it: the folder\'s permission')
      assert.equal((await agent('GET', file(image))).status, 404, 'only hidden notes use it')
    }

    // A note of its own, where it may write, that links to both.
    const own = `${home(MEMBER.username)}/${m.aTitle()}.md`
    const text = `# ${m.aHeading()}\n\n![](${dest(own, DIARY_IMAGE)})\n\n![](${dest(own, HIDDEN_IMAGE)})\n\n![](${dest(own, PATH.photo)})\n`
    const created = await agent('POST', '/api/note', { path: own, text })
    assert.equal(created.status, 201, created.text)
    for (const image of [DIARY_IMAGE, HIDDEN_IMAGE]) {
      const r = await agent('GET', file(image))
      assert.equal(r.status, 404, `${image}: a hidden note uses it`)
      assert.ok(!r.text.includes('PNG'))
    }
    // An image only notes it can read use is still for it.
    assert.equal((await agent('GET', file(PATH.photo))).status, 200)
  } finally { await h.close() }
})

test('the history gives an agent no bytes of an image a note hidden from agents uses (a restore would write them under another name)', async () => {
  const h = await setup({ files })
  try {
    const user = h.auth.user(h.users.member.id)!
    const principal = { kind: 'agent' as const, user, key: { id: m.faker.string.ulid(), name: m.aKeyName(), canWrite: true, folders: [] }, via: 'api' as const }
    const commit = m.faker.git.commitSha()
    const stored = { versions: async () => ({ versions: [], next: null }), version: async () => null, file: async () => new Uint8Array(PNG), changes: async () => ({ changes: [], next: null }), authors: async () => [] }
    const agent = historyFor(h.policy.for(principal), stored)
    for (const image of [DIARY_IMAGE, HIDDEN_IMAGE]) assert.equal(await agent.file(commit, image), null, image)
    assert.ok(await agent.file(commit, PATH.photo), 'an image only notes it can read use')
    const person = historyFor(h.policy.for({ kind: 'user', user }), stored)
    for (const image of [DIARY_IMAGE, HIDDEN_IMAGE]) assert.ok(await person.file(commit, image), `its user: ${image}`)
  } finally { await h.close() }
})
