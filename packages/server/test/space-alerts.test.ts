// The admin's alerts about the spaces (D-056, spec §1.1, §2.4, §5.7): what
// is outside every space, person folders of nobody, shared spaces without
// members or managers; and vihko.yaml's warnings, which never name a folder
// inside a space the admin doesn't read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIR, FILES, MEMBER, NOBODY, PATH, RULES, home, setup } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
type Alert = { code: string; paths?: string[]; names?: string[]; path?: string; name?: string; warnings?: { code: string; at: string | null; detail: string | null }[] }
const alertsOf = async (who: (method: string, path: string) => Promise<{ body: any }>) => (await who('GET', '/api/alerts')).body.alerts as Alert[]

test('the admin is told what is outside the spaces, person folders of nobody, and shared spaces without members or managers; nobody else is', async () => {
  const stray = m.aFolder()
  const noId = `${m.aFolder()}_`
  const empty = `spaces/${m.aSpaceFolder()}`
  const headless = `spaces/${m.aSpaceFolder()}`
  const name = m.aSpaceName()
  const config = RULES + `  ${yamlKey(headless)}:\n    name: ${JSON.stringify(name)}\n    grants: { ${yamlKey(MEMBER.username)}: edit }\n`
  const h = await setup({ files: { ...FILES, [m.aNotePath(stray)]: `# ${m.aHeading()}\n`, [`spaces/${noId}/${m.aTitle()}.md`]: `# ${m.aHeading()}\n`, [`${headless}/${m.aTitle()}.md`]: `# ${m.aHeading()}\n` }, config })
  try {
    mkdirSync(join(h.notesDir, empty), { recursive: true })
    writeFileSync(join(h.notesDir, 'people', m.aTitle()), 'not a folder')
    const admin = await alertsOf(h.admin)
    const outside = admin.find((a) => a.code === 'outside_spaces')!
    assert.ok(outside.paths!.includes(stray) && outside.paths!.includes(PATH.rootPlan) && outside.paths!.includes(`spaces/${noId}`), JSON.stringify(outside))
    assert.ok(!outside.paths!.includes('vihko.yaml'))
    assert.deepEqual(admin.find((a) => a.code === 'person_folder_without_user')?.names, [NOBODY])
    assert.deepEqual(admin.filter((a) => a.code === 'space_without_members').map((a) => a.path), [empty])
    assert.deepEqual(admin.filter((a) => a.code === 'space_without_managers').map((a) => [a.path, a.name]), [[headless, name]])
    // Nothing inside a space is named: only the top-level names, and spaces by their root and name.
    for (const a of admin.filter((x) => ['outside_spaces', 'person_folder_without_user', 'space_without_members', 'space_without_managers'].includes(x.code))) {
      assert.ok(!JSON.stringify(a).includes(`${headless}/`) && !JSON.stringify(a).includes(`${home(NOBODY)}/`), JSON.stringify(a))
    }
    for (const who of [h.member, h.other]) {
      assert.deepEqual((await alertsOf(who)).filter((a) => ['outside_spaces', 'person_folder_without_user', 'space_without_members', 'space_without_managers'].includes(a.code)), [])
    }
    // A deleted person's folder is their closed space: not a stray.
    assert.equal((await h.admin('POST', `/api/admin/users/${h.users.other.id}/disable`)).status, 200)
    assert.equal((await h.admin('DELETE', `/api/admin/users/${h.users.other.id}`)).status, 200)
    assert.deepEqual((await alertsOf(h.admin)).find((a) => a.code === 'person_folder_without_user')?.names, [NOBODY])
  } finally { await h.close() }
})

test('vihko.yaml\'s warnings name no folder inside a space the admin doesn\'t read', async () => {
  const [ghost, hidden] = [m.aUsername(), `${home(MEMBER.username)}/${m.aFolder()}`]
  const visible = `${DIR.shared}/${m.aFolder()}`
  const config = RULES + `  ${yamlKey(hidden)}:\n    grants: { ${yamlKey(ghost)}: read }\n  ${yamlKey(visible)}:\n    grants: { ${yamlKey(ghost)}: read }\n`
  const h = await setup({ files: FILES, config })
  try {
    const warnings = (await alertsOf(h.admin)).find((a) => a.code === 'config_warnings')!.warnings!.filter((w) => w.code === 'unknown_subject')
    assert.deepEqual(warnings.map((w) => [w.at, w.detail]).sort(), [['permissions', ghost], [`permissions.${visible}.grants.${ghost}`, ghost]].sort())
    assert.ok(!JSON.stringify(warnings).includes(hidden))
  } finally { await h.close() }
})
