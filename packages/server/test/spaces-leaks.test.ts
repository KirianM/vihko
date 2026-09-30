// The leak battery (M4's, m4-multiusuario.md §2, in spaces since D-056; spec
// §8.2): every HTTP route, MCP tool and hub message is classified (a new one
// without its line fails here), and two people and an agent walk every route
// and tool over the same tree: no response or error carries a path, a title,
// a fragment, a tag, a count or a candidate of what they can't see, unless
// the request itself named it. What each one can't see is computed with the
// access engine itself (the same the effective-access view uses). Writes
// aimed at what they can't see are spaces-writes.test.ts's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MessageType } from '@hocuspocus/server'
import * as server from '@vihko/server'
import { HUB_MESSAGES, ROUTE_NEEDS, TOOL_NEEDS, type Principal } from '@vihko/server'
import { ADMIN, DIR, FILES as BASE, MEMBER, NAME, NOBODY, OTHER, PATH, PNG, RULES, TAG, UID, WORD, home, setup } from './_m4.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** A conflict copy of the other member's note (its name as Syncthing writes it), with a word only it has. */
const CONFLICT = PATH.otherNotes.replace(/\.md$/, '.sync-conflict-20260927-100000-ABCDEFG.md')
const COPY = m.aUniqueWord()
/** An image in the admin's space (its name a word no text has). */
const LOGO = m.aUniqueWord()
const LOGO_PATH = `${DIR.admin}/${LOGO}.png`
/** A folder of the admin's space shared with the member alone (a subfolder of a space they're not in), and a note in it with a word only it has. */
const SURPRISE_DIR = `${DIR.admin}/${m.aFolder()}`
const SURPRISE = `${SURPRISE_DIR}/${m.aTitle()}.md`
const SURPRISE_WORD = m.aUniqueWord()
/** A folder of the other member's space shared with the member (a loose shared folder), next to what isn't shared. */
const LOOSE_DIR = `${home(OTHER.username)}/${m.aFolder()}`
const LOOSE = `${LOOSE_DIR}/${m.aTitle()}.md`
const LOOSE_WORD = m.aUniqueWord()
const FILES = {
  ...BASE,
  [LOGO_PATH]: PNG,
  [CONFLICT]: `# ${m.aHeading()}\n\n${m.aSentence()} ${COPY}.\n`,
  [SURPRISE]: `# ${m.aHeading()}\n\n${m.aSentence()} ${SURPRISE_WORD}.\n`,
  [LOOSE]: `# ${m.aHeading()}\n\n${m.aSentence()} ${LOOSE_WORD}. [[${NAME.list}]]\n`,
}

const member = home(MEMBER.username)
const other = home(OTHER.username)
const admin = home(ADMIN.username)
/**
 * What gives each note (or file) away: its path (or folder) and words only it
 * has. A person's folder ends in `/`: one username may start another's.
 */
const MARKS: Record<string, string[]> = {
  [PATH.list]: [PATH.list],
  [PATH.diary]: [`${member}/`, WORD.diary, TAG.intimate],
  [PATH.cake]: [`${member}/`, WORD.cake],
  [PATH.memberPhoto]: [PATH.memberPhoto.slice(member.length + 1)],
  [PATH.otherNotes]: [PATH.otherNotes.slice(other.length), WORD.other],
  [LOOSE]: [LOOSE_WORD],
  [CONFLICT]: ['sync-conflict', COPY],
  [PATH.adminPlan]: [`${admin}/`, WORD.admin],
  [PATH.adminPlanCased]: [`${admin}/`, WORD.admin],
  [PATH.nobodyNote]: [`${home(NOBODY)}/`, WORD.nobody],
  [PATH.settings]: [PATH.settings, WORD.settings],
  [LOGO_PATH]: [`${LOGO}.png`],
  [PATH.rootPlan]: [WORD.root],
  [SURPRISE]: [`${SURPRISE_DIR}/`, SURPRISE_WORD],
}

/**
 * Whether a mark shows in `text`: a word (a tag, say) as a whole word, since
 * a tag's letters may be part of another word; a path or a name, anywhere.
 */
const shows = (text: string, mark: string) => (/^[\p{L}\p{N}_-]+$/u.test(mark)
  ? new RegExp(`(?<![\\p{L}\\p{N}_])${mark}(?![\\p{L}\\p{N}_])`, 'u').test(text)
  : text.includes(mark))

type Who = 'member' | 'other' | 'agent' | 'admin'
/** What an admin's route answers: 403 to a person, 404 to an agent (not a route for keys); whatever it answers the admin. */
const adminOnly = (who: Who) => (who === 'admin' ? undefined : who === 'agent' ? 404 : 403)
interface Call { route: string; method: string; path: string; body?: unknown; headers?: Record<string, string>; expect?: number | string }

test('every HTTP route, MCP tool and hub message is classified by what it needs of the permissions', async () => {
  const h = await setup({ files: FILES })
  try {
    const routes = new Set<string>()
    for (const r of h.app.routes) if (r.method !== 'ALL' && r.path.startsWith('/api/')) routes.add(`${r.method} ${r.path}`)
    assert.deepEqual([...routes].filter((r) => !(r in ROUTE_NEEDS)), [], 'a new route must say what it needs in http/routes.ts ROUTE_NEEDS')
    assert.deepEqual(Object.keys(ROUTE_NEEDS).filter((r) => !routes.has(r)), [])
    await h.enable()
    const c = await h.mcp((await h.newKey('admin', { name: m.aKeyName(), canWrite: true })).token)
    const tools = (await c.client.listTools()).tools.map((t) => t.name).sort()
    await c.close()
    assert.deepEqual(tools, Object.keys(TOOL_NEEDS).sort(), 'a new tool must say what it needs in mcp/tools.ts TOOL_NEEDS')
    // Every message type of the protocol, and every message of vihko's own.
    const types = Object.keys(MessageType).filter((k) => Number.isNaN(Number(k)))
    assert.deepEqual(types.filter((t) => !(t in HUB_MESSAGES.inbound)), [], 'a new hocuspocus message type must be classified in hub.ts HUB_MESSAGES')
    const own = Object.entries(server).filter(([k, v]) => k.endsWith('_MESSAGE') && typeof v === 'string').map(([, v]) => v as string)
    assert.ok(own.length >= 7)
    assert.deepEqual(own.filter((m) => !(m in HUB_MESSAGES.outbound)).sort(), [])
  } finally { await h.close() }
})

test('two people and an agent over the same tree: nothing of what they can\'t see reaches them, through any route or tool', async () => {
  const h = await setup({ files: FILES, config: RULES + `  ${yamlKey(SURPRISE_DIR)}:\n    grants: { ${yamlKey(MEMBER.username)}: manage }\n  ${yamlKey(LOOSE_DIR)}:\n    grants: { ${yamlKey(MEMBER.username)}: comment }\n` })
  try {
    await h.enable()
    const agentKey = await h.newKey('admin', { name: m.aKeyName(), canWrite: true })
    const agentPrincipal: Principal = { kind: 'agent', user: h.users.admin, key: { id: agentKey.key.id, name: m.aKeyName(), canWrite: true, folders: [] }, via: 'api' }
    const principals: Record<Who, Principal> = {
      member: { kind: 'user', user: h.users.member },
      other: { kind: 'user', user: h.users.other },
      agent: agentPrincipal,
      // The admin reads their own space and the spaces they're in, never anyone else's (D-038.1, D-056).
      admin: { kind: 'user', user: h.users.admin },
    }
    // What each one can't see, by the access engine: those notes' marks.
    const hiddenMarks = (who: Who) => {
      const access = h.policy.for(principals[who])
      const seen = new Set(Object.keys(MARKS).filter((p) => access.canRead(p)).flatMap((p) => MARKS[p]!))
      return [...new Set(Object.keys(MARKS).filter((p) => !access.canRead(p)).flatMap((p) => MARKS[p]!))].filter((m) => !seen.has(m))
    }
    // Premises of the sweep: the admin's space's folder shared with the member alone; the other's folder shared with the member, and nothing else of the other's.
    assert.deepEqual((['member', 'other', 'agent', 'admin'] as Who[]).map((w) => h.policy.for(principals[w]).canRead(SURPRISE)), [true, false, true, true])
    assert.deepEqual((['member', 'other', 'agent', 'admin'] as Who[]).map((w) => h.policy.for(principals[w]).canRead(LOOSE)), [true, true, false, false])
    assert.deepEqual((['member', 'other', 'agent', 'admin'] as Who[]).map((w) => h.policy.for(principals[w]).canRead(PATH.otherNotes)), [false, true, false, false])
    // Nobody sees what is outside the spaces, nor a person folder of nobody: not even the admin.
    for (const w of ['member', 'other', 'agent', 'admin'] as Who[]) assert.deepEqual([PATH.rootPlan, PATH.nobodyNote].map((p) => h.policy.for(principals[w]).canRead(p)), [false, false], w)
    const own: Record<Who, string> = { member: PATH.cake, other: PATH.otherNotes, agent: PATH.adminPlan, admin: PATH.adminPlan }
    const hidden: Record<Who, string> = { member: PATH.adminPlan, other: PATH.cake, agent: PATH.cake, admin: PATH.cake }
    const hiddenFolder: Record<Who, string> = { member: DIR.admin, other: member, agent: member, admin: member }
    const hiddenImage: Record<Who, string> = { member: LOGO_PATH, other: PATH.memberPhoto, agent: PATH.memberPhoto, admin: PATH.memberPhoto }
    const shared = PATH.list

    // Some history, some trash and a conflict copy for everyone to (not) see.
    const put = async (as: (m: string, p: string, b?: unknown, hd?: Record<string, string>) => Promise<{ status: number; body: any }>, path: string, add: string) => {
      const cur = await as('GET', h.url('/api/note', { path }))
      const r = await as('PUT', h.url('/api/note', { path }), { text: cur.body.text + add }, { 'if-match': `"${cur.body.etag}"` })
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`)
      await h.settle()
    }
    await put(h.member, PATH.cake, `${WORD.cake} ${m.aSentence()}\n`)
    await put(h.member, shared, `${m.aSentence()}\n`)
    await put(h.admin, PATH.settings, `${WORD.settings} ${m.aSentence()}\n`)
    await put(h.other, PATH.otherNotes, `${WORD.other} ${m.aSentence()}\n`)
    await put(h.admin, SURPRISE, `${SURPRISE_WORD} ${m.aSentence()}\n`)
    // A note of the admin's in the trash, with a word of theirs.
    const draft = `${DIR.admin}/${m.aTitle()}.md`
    assert.equal((await h.admin('POST', '/api/note', { path: draft, text: `# ${m.aHeading()} ${WORD.settings}\n` })).status, 201)
    assert.equal((await h.admin('DELETE', h.url('/api/note', { path: draft }))).status, 200)
    const adminTrash = ((await h.admin('GET', '/api/trash')).body.entries as { id: string }[])[0]!.id
    const versionOf = async (path: string) => ((await h.member('GET', h.url('/api/history/versions', { path }))).body.versions as { id: string }[])[0]!.id
    const sharedVersion = await versionOf(shared)
    const memberVersion = await versionOf(PATH.cake)
    const q = (path: string, params: Record<string, string>) => h.url(path, params)
    // Notices addressed to each person about a purge of what they can't read now (M4.1): never its path.
    const store = new server.Notices(h.auth.state)
    const notice = {
      member: store.add(h.users.member.id, { code: 'history_purged_authored', by: h.users.admin.id, path: hidden.member, version: true })!.id,
      other: store.add(h.users.other.id, { code: 'history_purged_authored', by: h.users.admin.id, path: hidden.other, version: false })!.id,
    }

    const calls = (who: Who): Call[] => {
      const mine = own[who]
      const theirs = hidden[who]
      const folder = hiddenFolder[who]
      const version = who === 'member' ? memberVersion : sharedVersion
      const note = (p: string) => q('/api/note', { path: p })
      return [
        { route: 'GET /api/health', method: 'GET', path: '/api/health' },
        { route: 'GET /api/setup', method: 'GET', path: '/api/setup' },
        { route: 'POST /api/setup', method: 'POST', path: '/api/setup', body: { token: m.aSecret(43), username: m.aUsername(), password: m.aPassword() } },
        { route: 'POST /api/auth/login', method: 'POST', path: '/api/auth/login', body: { username: m.aUsername(), password: m.aPassword() } },
        { route: 'GET /api/auth/me', method: 'GET', path: '/api/auth/me' },
        { route: 'GET /api/config', method: 'GET', path: '/api/config' },
        { route: 'GET /api/workspace', method: 'GET', path: '/api/workspace' },
        { route: 'GET /api/profile', method: 'GET', path: '/api/profile' },
        { route: 'PUT /api/profile', method: 'PUT', path: '/api/profile', body: {} },
        { route: 'GET /api/integrations', method: 'GET', path: '/api/integrations' },
        { route: 'PUT /api/admin/integrations', method: 'PUT', path: '/api/admin/integrations', body: { api: true }, expect: adminOnly(who) },
        { route: 'GET /api/keys', method: 'GET', path: '/api/keys' },
        { route: 'POST /api/keys', method: 'POST', path: '/api/keys', body: { name: m.aKeyName(), folders: [folder] } },
        { route: 'PATCH /api/keys/:id', method: 'PATCH', path: `/api/keys/${agentKey.key.id}`, body: { name: m.aKeyName() } },
        { route: 'DELETE /api/keys/:id', method: 'DELETE', path: '/api/keys/nope' },
        { route: 'POST /api/keys/:id/rotate', method: 'POST', path: `/api/keys/${agentKey.key.id}/rotate` },
        { route: 'GET /api/oauth/authorize', method: 'GET', path: '/api/oauth/authorize' },
        { route: 'POST /api/oauth/authorize', method: 'POST', path: '/api/oauth/authorize', body: {} },
        { route: 'POST /api/admin/rescan', method: 'POST', path: '/api/admin/rescan', body: {}, expect: adminOnly(who) },
        { route: 'POST /api/admin/users', method: 'POST', path: '/api/admin/users', body: { username: m.aUsername(), password: m.aPassword() }, expect: adminOnly(who) },

        { route: 'GET /api/tree', method: 'GET', path: '/api/tree', expect: 200 },
        { route: 'GET /api/tags', method: 'GET', path: '/api/tags', expect: 200 },
        ...[WORD.diary, WORD.cake, WORD.other, WORD.admin, WORD.settings, WORD.nobody, NAME.list, SURPRISE_WORD, NAME.plan, `tag:${TAG.intimate}`, `tag:${TAG.home}`, `path:"${DIR.people}"`, `path:"${DIR.admin}"`, `path:"${DIR.shared}"`, COPY]
          .map((s) => ({ route: 'GET /api/search', method: 'GET', path: q('/api/search', { q: s }), expect: 200 })),
        { route: 'GET /api/trash', method: 'GET', path: '/api/trash' },
        { route: 'GET /api/alerts', method: 'GET', path: '/api/alerts' },
        { route: 'GET /api/history/status', method: 'GET', path: '/api/history/status', expect: 200 },
        { route: 'GET /api/history/changes', method: 'GET', path: '/api/history/changes?limit=200', expect: 200 },
        { route: 'GET /api/move-jobs/:id', method: 'GET', path: '/api/move-jobs/nope' },

        ...[mine, shared, theirs, theirs.replace('.md', '-no.md')].map((p) => ({ route: 'GET /api/note', method: 'GET', path: note(p) })),
        ...[mine, shared, theirs].map((p) => ({ route: 'GET /api/note/links', method: 'GET', path: q('/api/note/links', { path: p }) })),
        ...[shared, theirs].map((p) => ({ route: 'GET /api/note/headings', method: 'GET', path: q('/api/note/headings', { path: p }) })),
        ...[shared, theirs].map((p) => ({ route: 'GET /api/note/comments', method: 'GET', path: q('/api/note/comments', { path: p }) })),
        { route: 'GET /api/daily', method: 'GET', path: '/api/daily' },
        ...[PATH.photo, hiddenImage[who]].map((p) => ({ route: 'GET /api/file', method: 'GET', path: q('/api/file', { path: p }) })),
        { route: 'GET /api/conflict', method: 'GET', path: q('/api/conflict', { path: CONFLICT }) },

        { route: 'POST /api/note', method: 'POST', path: '/api/note', body: { path: `${folder}/${m.aTitle()}.md`, text: m.aSentence() } },
        { route: 'POST /api/note', method: 'POST', path: '/api/note', body: { path: `${DIR.shared}/${m.aTitle()}.md`, template: theirs } },
        { route: 'POST /api/note', method: 'POST', path: '/api/note', body: { path: theirs, text: m.aSentence() } },
        { route: 'PUT /api/note', method: 'PUT', path: note(theirs), body: { text: m.aSentence() }, headers: { 'if-match': '"sha256:x"' } },
        { route: 'PUT /api/note', method: 'PUT', path: note(theirs), body: { text: m.aSentence() }, headers: { 'if-none-match': '*' } },
        { route: 'POST /api/note/edit', method: 'POST', path: '/api/note/edit', body: { path: theirs, ops: [{ op: 'append', text: m.aSentence() }] } },
        { route: 'POST /api/note/move', method: 'POST', path: '/api/note/move', body: { from: shared, to: `${DIR.shared}/${m.aTitle()}.md`, dryRun: true } },
        { route: 'POST /api/note/move', method: 'POST', path: '/api/note/move', body: { from: theirs, to: `${DIR.shared}/${m.aTitle()}.md`, dryRun: true } },
        { route: 'POST /api/note/move', method: 'POST', path: '/api/note/move', body: { from: mine, to: theirs, dryRun: true } },
        { route: 'DELETE /api/note', method: 'DELETE', path: note(theirs) },
        { route: 'POST /api/daily', method: 'POST', path: '/api/daily', body: {} },
        { route: 'POST /api/attachments', method: 'POST', path: q('/api/attachments', { note: theirs }), body: PNG },
        { route: 'POST /api/attachments/fetch', method: 'POST', path: '/api/attachments/fetch', body: { note: theirs, url: 'http://127.0.0.1:9/x.png' } },
        { route: 'POST /api/note/link/pin', method: 'POST', path: '/api/note/link/pin', body: { path: shared, raw: `[[${NAME.plan}]]`, target: PATH.adminPlanCased } },
        { route: 'POST /api/note/orphan', method: 'POST', path: '/api/note/orphan', body: { path: theirs, action: 'discard' } },
        { route: 'POST /api/external-moves/:id/relink', method: 'POST', path: '/api/external-moves/nope/relink', body: { dryRun: true } },
        { route: 'POST /api/trash/:id/restore', method: 'POST', path: `/api/trash/${adminTrash}/restore`, body: {} },
        { route: 'POST /api/folder', method: 'POST', path: '/api/folder', body: { path: `${folder}/${m.aFolder()}` } },
        { route: 'DELETE /api/folder', method: 'DELETE', path: q('/api/folder', { path: folder }) },
        { route: 'POST /api/folder/move', method: 'POST', path: '/api/folder/move', body: { from: folder, to: `${DIR.shared}/${m.aFolder()}`, dryRun: true } },
        { route: 'POST /api/folder/move', method: 'POST', path: '/api/folder/move', body: { from: DIR.shared, to: m.aFolder(), dryRun: true } },

        ...[mine, shared, theirs].map((p) => ({ route: 'GET /api/history/versions', method: 'GET', path: q('/api/history/versions', { path: p }) })),
        ...[mine, theirs].map((p) => ({ route: 'GET /api/history/version', method: 'GET', path: q('/api/history/version', { path: p, id: version }) })),
        ...[mine, theirs].map((p) => ({ route: 'GET /api/history/diff', method: 'GET', path: q('/api/history/diff', { path: p, id: version, against: 'current' }) })),
        ...[shared, theirs].map((p) => ({ route: 'GET /api/history/resolved', method: 'GET', path: q('/api/history/resolved', { path: p }) })),
        { route: 'POST /api/history/restore', method: 'POST', path: '/api/history/restore', body: { path: theirs, id: memberVersion } },
        { route: 'POST /api/history/revert', method: 'POST', path: '/api/history/revert', body: { path: theirs, id: memberVersion, dryRun: true } },
        // Purging (D-038.9): what they can't see, by name, as a note, a version or a folder (the admin may, without reading it).
        { route: 'POST /api/history/purge', method: 'POST', path: '/api/history/purge', body: { path: theirs, dryRun: true }, expect: who === 'admin' ? undefined : 404 },
        { route: 'POST /api/history/purge', method: 'POST', path: '/api/history/purge', body: { path: theirs, version: memberVersion, dryRun: true }, expect: who === 'admin' ? undefined : 404 },
        { route: 'POST /api/history/purge', method: 'POST', path: '/api/history/purge', body: { path: `${folder}/nada.md`, dryRun: true }, expect: who === 'admin' ? undefined : 404 },
        { route: 'POST /api/history/purge', method: 'POST', path: '/api/history/purge', body: { path: folder, dryRun: true }, expect: who === 'admin' ? undefined : who === 'agent' ? 404 : 400 },
        { route: 'DELETE /api/history/purges/:id', method: 'DELETE', path: '/api/history/purges/nope', expect: adminOnly(who) },
        // Commenting (D-038.5): on what they can't see, and a thread that isn't there.
        { route: 'POST /api/note/comment', method: 'POST', path: '/api/note/comment', body: { path: theirs, op: 'add', at: 0, context: '', text: m.aComment() }, expect: 404 },
        { route: 'POST /api/note/comment', method: 'POST', path: '/api/note/comment', body: { path: theirs, op: 'resolve', thread: 'x|y|z|0' }, expect: 404 },
        { route: 'POST /api/note/comment', method: 'POST', path: '/api/note/comment', body: { path: shared, op: 'resolve', thread: 'x|y|z|0' }, expect: who === 'agent' ? 404 : 412 },

        ...[folder, PATH.cake.slice(0, PATH.cake.lastIndexOf('/')), DIR.shared].map((f) => ({ route: 'GET /api/permissions', method: 'GET', path: q('/api/permissions', { folder: f }) })),
        { route: 'PUT /api/permissions', method: 'PUT', path: '/api/permissions', body: { folder, grants: {}, ifMatch: 'x' } },
        { route: 'GET /api/permissions/folders', method: 'GET', path: '/api/permissions/folders' },
        { route: 'GET /api/permissions/access', method: 'GET', path: '/api/permissions/access' },
        { route: 'GET /api/permissions/access', method: 'GET', path: q('/api/permissions/access', { user: h.users.admin.id }) },
        { route: 'POST /api/permissions/holds/:id', method: 'POST', path: '/api/permissions/holds/nope', body: { action: 'release' } },
        // Users and groups (piece U): names only, one's own account, and the admin's.
        { route: 'GET /api/invite/:token', method: 'GET', path: '/api/invite/nope' },
        { route: 'POST /api/invite/:token', method: 'POST', path: '/api/invite/nope', body: { password: m.aPassword() } },
        { route: 'GET /api/directory', method: 'GET', path: '/api/directory' },
        { route: 'GET /api/account/sessions', method: 'GET', path: '/api/account/sessions' },
        { route: 'DELETE /api/account/sessions/:id', method: 'DELETE', path: '/api/account/sessions/nope' },
        { route: 'DELETE /api/account/sessions', method: 'DELETE', path: '/api/account/sessions' },
        { route: 'POST /api/auth/password', method: 'POST', path: '/api/auth/password', body: { current: m.aPassword(), password: m.aPassword() } },
        // One's own notices: someone else's doesn't exist.
        { route: 'DELETE /api/account/notices/:id', method: 'DELETE', path: `/api/account/notices/${who === 'member' ? notice.other : notice.member}`, expect: 404 },
        // The second factor: pending tokens and codes that don't exist, one's own, and the admin's reset.
        { route: 'POST /api/auth/login/code', method: 'POST', path: '/api/auth/login/code', body: { token: m.aSecret(43), code: '000000' } },
        { route: 'POST /api/auth/2fa/setup', method: 'POST', path: '/api/auth/2fa/setup', body: { token: m.aSecret(43) } },
        { route: 'POST /api/auth/2fa/enable', method: 'POST', path: '/api/auth/2fa/enable', body: { token: m.aSecret(43), code: '000000' } },
        { route: 'GET /api/account/2fa', method: 'GET', path: '/api/account/2fa' },
        { route: 'POST /api/account/2fa/setup', method: 'POST', path: '/api/account/2fa/setup', body: { password: m.aPassword() } },
        { route: 'POST /api/account/2fa/enable', method: 'POST', path: '/api/account/2fa/enable', body: { code: '000000' } },
        { route: 'POST /api/account/2fa/recovery', method: 'POST', path: '/api/account/2fa/recovery', body: { confirm: m.aPassword() } },
        { route: 'POST /api/account/2fa/disable', method: 'POST', path: '/api/account/2fa/disable', body: { code: '000000' } },
        { route: 'POST /api/admin/users/:id/2fa/reset', method: 'POST', path: '/api/admin/users/nope/2fa/reset', expect: adminOnly(who) },
        ...([
          ['GET', '/api/admin/users'], ['POST', '/api/admin/users/nope/link'], ['PUT', '/api/admin/users/nope/role'],
          ['POST', '/api/admin/users/nope/disable'], ['POST', '/api/admin/users/nope/enable'], ['DELETE', '/api/admin/users/nope'],
          ['DELETE', '/api/admin/users/nope/sessions'], ['GET', '/api/admin/groups'], ['POST', '/api/admin/groups'],
          ['PATCH', '/api/admin/groups/nope'], ['DELETE', '/api/admin/groups/nope'], ['POST', '/api/admin/groups/nope/members'],
          ['DELETE', '/api/admin/groups/nope/members/nope'], ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings'],
          ['DELETE', '/api/admin/config-migrations/nope'], ['DELETE', '/api/admin/state-migrations/nope'],
        ] as const).map(([method, path]) => ({
          route: `${method} ${path.replace(/\/nope(?=\/members\/)/, '/:id').replace(/members\/nope$/, 'members/:userId').replace(/\/nope/, '/:id')}`,
          method, path, body: method === 'GET' || method === 'DELETE' ? undefined : {}, expect: adminOnly(who),
        })),
        // Last: it ends the session.
        { route: 'POST /api/auth/logout', method: 'POST', path: '/api/auth/logout' },
      ]
    }

    const before = Object.values(hidden).map((p) => readFileSync(join(h.notesDir, p), 'utf8'))
    const covered = new Set<string>()
    // The admin last: their key (the agent's) and every other session have walked it all by then.
    for (const who of ['member', 'other', 'agent', 'admin'] as Who[]) {
      const send = who === 'agent' ? h.withKey(agentKey.token) : h.as(who)
      const all = hiddenMarks(who)
      assert.ok(all.length > 5, `${who} has something not to see`)
      for (const call of calls(who)) {
        covered.add(call.route)
        const marks = all
        const r = await send(call.method, call.path, call.body, call.headers)
        // The query as the server reads it (form encoding: a space is `+`).
        const asked = decodeURIComponent(call.path.replace(/\+/g, ' ')) + JSON.stringify(call.body ?? '')
        const shown = r.text + JSON.stringify([...r.headers.entries()])
        const where = `${who}: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '').slice(0, 120)} → ${r.status} ${r.text.slice(0, 300)}`
        assert.deepEqual(marks.filter((mk) => shows(shown, mk) && !asked.includes(mk)), [], where)
        assert.ok(r.status < 500, where)
        if (typeof call.expect === 'number') assert.equal(r.status, call.expect, where)
        // Whatever it can't see doesn't exist for a person: never `forbidden` about it.
        if (who !== 'agent' && r.status === 403 && asked.includes(hidden[who])) assert.fail(`${where}: forbidden about something it can't see`)
        // An agent that names a note its user can't see gets `not_found`, as for one that doesn't exist (D-056.15); a denial only for what its user sees.
        if (who === 'agent' && r.body?.error === 'agent_denied') assert.equal(r.body.reason, 'ai_false', where)
      }
    }
    assert.deepEqual(Object.keys(ROUTE_NEEDS).filter((r) => !covered.has(r)), [], 'every route has its leak scenarios')

    // The MCP server, for the agent: every tool, naming what its user can't see.
    const c = await h.mcp(agentKey.token)
    const marks = hiddenMarks('agent')
    const theirs = hidden.agent
    const toolCalls: [string, Record<string, unknown>][] = [
      ...[WORD.diary, WORD.cake, WORD.other, WORD.nobody, NAME.list, SURPRISE_WORD, `tag:${TAG.intimate}`, `path:"${DIR.people}"`].map((query): [string, Record<string, unknown>] => ['search', { query }]),
      ['get_note', { path: theirs }], ['get_note', { path: shared }], ['get_note', { uid: UID.cake }],
      ['list_folder', { folder: '' , recursive: true }], ['list_folder', { folder: DIR.people }], ['list_folder', { folder: member }],
      ['related', { path: shared }], ['related', { path: theirs }],
      ['resolve_link', { from: shared, link: `[[${NAME.cake}]]` }], ['resolve_link', { from: shared, link: `[[${NAME.plan}]]` }], ['resolve_link', { from: theirs, link: `[[${NAME.list}]]` }],
      ['changes_since', { path: theirs, since: 'sha256:x' }], ['changes_since', { path: shared, since: sharedVersion }],
      ['history', { path: theirs }], ['history', { path: shared }], ['history', { path: shared, version: sharedVersion }],
      ['daily_note', { create: false }],
      ['create_note', { path: `${member}/${m.aTitle()}.md`, text: m.aSentence() }], ['create_note', { path: `${DIR.shared}/${m.aTitle()}.md`, template: theirs }],
      ['edit_note', { path: theirs, operations: [{ op: 'append', text: m.aSentence() }] }],
      ['move', { from: shared, to: `${DIR.shared}/${m.aTitle()}.md`, dry_run: true }], ['move', { from: theirs, to: `${DIR.shared}/${m.aTitle()}.md`, dry_run: true }],
      ['delete', { path: theirs }],
      ['attach_image', { note: theirs, data: PNG.toString('base64') }],
      ['revert_change', { path: theirs, version: memberVersion, dry_run: true }],
    ]
    const toolsCovered = new Set<string>()
    for (const [name, args] of toolCalls) {
      toolsCovered.add(name)
      const r = await c.call(name, args)
      const asked = JSON.stringify(args)
      assert.deepEqual(marks.filter((mk) => shows(r.raw, mk) && !asked.includes(mk)), [], `${name} ${asked}: ${r.raw.slice(0, 400)}`)
      if (r.error && r.data?.error === 'agent_denied') assert.equal(r.data.reason, 'ai_false', `${name} ${asked}`)
    }
    await c.close()
    assert.deepEqual(Object.keys(TOOL_NEEDS).filter((t) => !toolsCovered.has(t)), [], 'every tool has its leak scenarios')

    // Every write aimed at what they can't see was refused and wrote nothing.
    assert.deepEqual(Object.values(hidden).map((p) => readFileSync(join(h.notesDir, p), 'utf8')), before)
  } finally { await h.close() }
})

test('with read or comment in a folder, nothing is written there through any route or tool that writes: forbidden, since they see it', async () => {
  // A folder of the admin's space the member reads and the other comments on; the admin manages it.
  const folder = `${DIR.admin}/${m.aFolder()}`
  const note = m.aNotePath(folder)
  const image = `${folder}/${m.aUniqueWord()}.png`
  const config = RULES + `  ${yamlKey(folder)}:\n    grants: { ${yamlKey(MEMBER.username)}: read, ${yamlKey(OTHER.username)}: comment, ${yamlKey(ADMIN.username)}: manage }\n`
  const h = await setup({ files: { ...BASE, [note]: `# ${m.aHeading()}\n\n${m.aSentence()} [[${NAME.list}]]\n`, [image]: PNG }, config })
  try {
    await h.enable()
    // A version to restore and revert.
    const cur = (await h.admin('GET', h.url('/api/note', { path: note }))).body
    assert.equal((await h.admin('PUT', h.url('/api/note', { path: note }), { text: cur.text + `${m.aSentence()}\n` }, { 'if-match': `"${cur.etag}"` })).status, 200)
    await h.settle()
    const version = ((await h.admin('GET', h.url('/api/history/versions', { path: note }))).body.versions as { id: string }[])[0]!.id
    const text = () => readFileSync(join(h.notesDir, note), 'utf8')
    const listing = () => readdirSync(join(h.notesDir, folder), { recursive: true }).map(String).sort()
    const before = { text: text(), files: listing(), yaml: readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8') }
    const etag = (await h.member('GET', h.url('/api/note', { path: note }))).body.etag as string

    const writes = (who: 'member' | 'other'): Call[] => [
      { route: 'PUT /api/note', method: 'PUT', path: h.url('/api/note', { path: note }), body: { text: m.aSentence() }, headers: { 'if-match': `"${etag}"` } },
      { route: 'POST /api/note', method: 'POST', path: '/api/note', body: { path: m.aNotePath(folder), text: m.aSentence() } },
      { route: 'PUT /api/note', method: 'PUT', path: h.url('/api/note', { path: m.aNotePath(folder) }), body: { text: m.aSentence() }, headers: { 'if-none-match': '*' } },
      { route: 'POST /api/note/edit', method: 'POST', path: '/api/note/edit', body: { path: note, ops: [{ op: 'append', text: m.aSentence() }] } },
      { route: 'DELETE /api/note', method: 'DELETE', path: h.url('/api/note', { path: note }) },
      { route: 'POST /api/note/move', method: 'POST', path: '/api/note/move', body: { from: note, to: m.aNotePath(DIR.shared) } },
      { route: 'POST /api/note/move', method: 'POST', path: '/api/note/move', body: { from: PATH.list, to: m.aNotePath(folder) } },
      { route: 'POST /api/attachments', method: 'POST', path: h.url('/api/attachments', { note }), body: PNG },
      { route: 'POST /api/attachments/fetch', method: 'POST', path: '/api/attachments/fetch', body: { note, url: 'http://127.0.0.1:9/x.png' } },
      { route: 'POST /api/note/link/pin', method: 'POST', path: '/api/note/link/pin', body: { path: note, raw: `[[${NAME.list}]]`, target: PATH.list } },
      { route: 'POST /api/folder', method: 'POST', path: '/api/folder', body: { path: `${folder}/${m.aFolder()}` } },
      { route: 'DELETE /api/folder', method: 'DELETE', path: h.url('/api/folder', { path: folder }) },
      { route: 'POST /api/folder/move', method: 'POST', path: '/api/folder/move', body: { from: folder, to: `${DIR.shared}/${m.aFolder()}` } },
      { route: 'GET /api/history/versions', method: 'GET', path: h.url('/api/history/versions', { path: note }) },
      { route: 'POST /api/history/restore', method: 'POST', path: '/api/history/restore', body: { path: note, id: version } },
      { route: 'POST /api/history/revert', method: 'POST', path: '/api/history/revert', body: { path: note, id: version } },
      { route: 'POST /api/history/purge', method: 'POST', path: '/api/history/purge', body: { path: note } },
      { route: 'PUT /api/permissions', method: 'PUT', path: '/api/permissions', body: { folder, grants: { [who === 'member' ? MEMBER.username : OTHER.username]: 'manage' }, ifMatch: 'x' } },
      // Commenting takes `comment`: the member, who only reads, can't.
      ...(who === 'member' ? [{ route: 'POST /api/note/comment', method: 'POST', path: '/api/note/comment', body: { path: note, op: 'add', at: 0, context: '', text: m.aComment() } }] : []),
    ]
    for (const who of ['member', 'other'] as const) {
      for (const call of writes(who)) {
        const r = await h.as(who)(call.method, call.path, call.body, call.headers)
        assert.deepEqual([r.status, r.body?.error], [403, 'forbidden'], `${who}: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '').slice(0, 120)} → ${r.text.slice(0, 300)}`)
      }
    }
    // A key that may write, of the member who only reads: its writing tools are refused.
    const key = await h.newKey('member', { name: m.aKeyName(), canWrite: true })
    const c = await h.mcp(key.token)
    for (const [name, args] of [
      ['edit_note', { path: note, operations: [{ op: 'append', text: m.aSentence() }] }],
      ['create_note', { path: m.aNotePath(folder), text: m.aSentence() }],
      ['move', { from: note, to: m.aNotePath(DIR.shared) }],
      ['delete', { path: note }],
      ['attach_image', { note, data: PNG.toString('base64') }],
      ['revert_change', { path: note, version }],
      ['history', { path: note }],
    ] as [string, Record<string, unknown>][]) {
      const r = await c.call(name, args)
      assert.ok(r.error, `${name}: ${r.raw.slice(0, 300)}`)
      assert.equal(r.data?.error, 'forbidden', `${name}: ${r.raw.slice(0, 300)}`)
    }
    await c.close()
    assert.deepEqual({ text: text(), files: listing(), yaml: readFileSync(join(h.notesDir, 'vihko.yaml'), 'utf8') }, before, 'nothing was written')
  } finally { await h.close() }
})
