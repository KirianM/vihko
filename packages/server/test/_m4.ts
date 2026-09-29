// The M4 scenario (m4-multiusuario.md §7), shared by the permission tests
// and the leak sweep: an admin, a member and another member, a group of the
// two members (until piece U brings groups, a stand-in `groupsOf`), and a
// vault (FILES) whose folders, notes, tags and words are the mother's too,
// the same for every setup of a test file. Rules: the root is the admin's;
// `<DIR.people>/{user}` → `manage`; the shared folder (`DIR.shared`) → the
// group edits it, and the admin; the member's diary with `ai: false`. The
// API with keys, the MCP server and the history, in process.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ApiKeys, Auth, History, Indexer, Integrations, NoteService, PermissionHolds, PermissionsEngine, Profiles, Workspace, createServer, mountMcp, openIndex, openState, stateDirectory, toolData, AccessPolicy, type Runtime } from '@vihko/server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { tempDir } from './_tmp.ts'
import { yamlKey } from './_permissions.ts'
import { mother } from '../../../test/mother.ts'

const m = mother(import.meta.url)
/** The people of the scenario: their usernames and passwords (created by every setup). */
export const ADMIN = m.aUser({ role: 'admin' })
export const MEMBER = m.aUser({ role: 'member' })
export const OTHER = m.aUser({ role: 'member' })
/** The group of the two members. */
export const GROUP = m.aGroupName()
/** A name nobody has: `<DIR.people>/<NOBODY>` is the folder of no user. */
export const NOBODY = m.aUsername()

/** The folders of the scenario: the shared one, the one of everyone's own, the admin's. */
export const DIR = { shared: m.aFolder(), people: m.aFolder(), admin: m.aFolder() }
/** The member's diary and recipes folders, inside their own. */
const DIARY_DIR = m.aFolder()
const RECIPES_DIR = m.aFolder()
/** Note names (without `.md`) that other notes link to. */
export const NAME = { list: m.aTitle(), cake: m.aTitle(), plan: m.aTitle(), photo: m.aFolder() }
/** A tag of the shared list and the diary, and one of the diary alone. */
export const TAG = { home: m.aTag(), intimate: m.aTag() }
/** Words only one note has, to find it by searching (and to spot it where it mustn't be). */
export const WORD = {
  diary: m.aUniqueWord(), cake: m.aUniqueWord(), other: m.aUniqueWord(), admin: m.aUniqueWord(),
  nobody: m.aUniqueWord(), settings: m.aUniqueWord(), root: m.aUniqueWord(),
}
/** The uids the list and the recipe carry. */
export const UID = { list: m.faker.string.ulid(), cake: m.faker.string.ulid() }
/** Each person's own folder. */
export const home = (username: string) => `${DIR.people}/${username}`
/** The notes and images of FILES, by what they are. */
export const PATH = {
  list: `${DIR.shared}/${NAME.list}.md`,
  photo: `${DIR.shared}/${NAME.photo}.png`,
  diaryDir: `${home(MEMBER.username)}/${DIARY_DIR}`,
  diary: `${home(MEMBER.username)}/${DIARY_DIR}/2026-09-27.md`,
  cake: `${home(MEMBER.username)}/${RECIPES_DIR}/${NAME.cake}.md`,
  memberPhoto: `${home(MEMBER.username)}/${NAME.photo}-${MEMBER.username}.png`,
  otherNotes: `${home(OTHER.username)}/${m.aTitle()}.md`,
  // Two notes of the admin whose names differ only in case, and one more at the root.
  adminPlan: `${home(ADMIN.username)}/${NAME.plan.toLowerCase()}.md`,
  adminPlanCased: `${home(ADMIN.username)}/${NAME.plan}.md`,
  nobodyNote: `${home(NOBODY)}/${m.aTitle()}.md`,
  settings: `${DIR.admin}/${m.aTitle()}.md`,
  rootPlan: `${NAME.plan}.md`,
}

/** A 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export const RULES = `# Who reads what
permissions:
  "":
    grants: { ${yamlKey(ADMIN.username)}: manage }
  ${yamlKey(DIR.shared)}:
    grants: { ${yamlKey(`@${GROUP}`)}: edit, ${yamlKey(ADMIN.username)}: edit }
  ${yamlKey(`${DIR.people}/{user}`)}:
    grants: { "{user}": manage }
  ${yamlKey(PATH.diaryDir)}:
    ai: false
`

export const USERS = { admin: ADMIN, member: MEMBER, other: OTHER } as const
export type Name = keyof typeof USERS

export interface M4Setup {
  files?: Record<string, string | Uint8Array>
  /** vihko.yaml (RULES by default). */
  config?: string
  /** Group memberships by group name (GROUP: the member and the other by default). */
  groups?: Record<string, Name[]>
}

export async function setup(opts: M4Setup = {}) {
  const dir = tempDir('vihko-m4-')
  const notesDir = join(dir, 'notes')
  const stateDir = join(dir, 'state')
  mkdirSync(notesDir, { recursive: true })
  for (const [p, content] of Object.entries(opts.files ?? {})) {
    if (p.endsWith('/')) { mkdirSync(join(notesDir, p), { recursive: true }); continue }
    mkdirSync(dirname(join(notesDir, p)), { recursive: true })
    writeFileSync(join(notesDir, p), content)
  }
  writeFileSync(join(notesDir, 'vihko.yaml'), opts.config ?? RULES)
  const index = openIndex(join(dir, 'index.db'))
  const state = openState(join(dir, 'state.db'))
  const auth = new Auth(state)
  const profiles = new Profiles(state)
  const users = {} as Record<Name, Awaited<ReturnType<Auth['createUser']>> & { password: string }>
  for (const [name, u] of Object.entries(USERS)) users[name as Name] = { ...(await auth.createUser(u.username, u.password, u.role)), password: u.password }
  const groupList: Record<string, Name[]> = { ...(opts.groups ?? { [GROUP]: ['member', 'other'] }) }
  const groups = {
    groupsOf: (id: string) => Object.entries(groupList).filter(([, m]) => m.some((n) => users[n].id === id)).map(([g]) => g),
    groups: () => Object.keys(groupList),
  }
  const workspace = new Workspace({ notesDir })
  const indexer = new Indexer({ notesDir, db: index })
  const runtime: Runtime = { lastScan: null, rescan(o) { return (this.lastScan = indexer.scan(o)) } }
  const permissions = new PermissionsEngine({ source: () => workspace.permissions, directory: stateDirectory(state, groups) })
  const holds = new PermissionHolds({ stateDir, engine: permissions })
  indexer.onMoves = (m) => holds.consider(m)
  runtime.rescan({})
  const keys = new ApiKeys(state)
  const integrations = new Integrations(state)
  const history = new History({
    notesDir, stateDir, config: () => workspace.config.history,
    quietMs: 100, maxOpenMs: 60_000, tickMs: 20, retryMs: 50,
    nameOf: (a) => (a.kind === 'user' ? auth.username(a.id) ?? a.id : a.kind === 'agent' ? keys.nameOf(a.id) ?? a.id : a.kind),
    log: () => {},
  })
  await history.open()
  await history.start()
  await history.recorder.settle()
  indexer.onApplied = (a) => history.recorder.observeIndexed(a)
  const notes = new NoteService({ notesDir, stateDir, indexer, db: index, history: history.recorder, attachments: () => workspace.config.attachments })
  const policy = new AccessPolicy({ index, permissions, holds })
  const { app, services } = createServer({
    auth, profiles, workspace, notes, index, indexer, notesDir, runtime, history, keys, integrations, policy, holds, groups,
    now: () => new Date('2026-09-27T10:00:00Z'),
    routes: (a, s) => { mountMcp(a, s, { auth, workspace, pollMs: 25 }) },
  })

  const cookies = {} as Record<Name, string>
  for (const name of Object.keys(users) as Name[]) {
    const { username, password } = users[name]
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0]!
  }

  interface Res { status: number; body: any; text: string; headers: Headers }
  const send = async (method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Res> => {
    const raw = body instanceof Uint8Array
    const res = await app.request(path, {
      method,
      headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : raw ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
    })
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8')
    let parsed: unknown = null
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text, headers: res.headers }
  }
  const as = (user: Name) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(method, path, body, { cookie: cookies[user], ...headers })
  const withKey = (token: string) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(method, path, body, { authorization: `Bearer ${token}`, ...headers })
  const newKey = async (who: Name, input: Record<string, unknown>) => {
    const r = await as(who)('POST', '/api/keys', { confirm: users[who].password, ...input })
    if (r.status !== 201) throw new Error(`key: ${r.status} ${r.text}`)
    return r.body as { key: { id: string }; token: string }
  }
  /** The admin turns on what the scenario uses: the API, the MCP server, and members' keys (all off on a new vihko, D-049). */
  const enable = async () => {
    for (const s of [{ api: true }, { mcp: true }, { membersCanCreateKeys: true }]) {
      const r = await as('admin')('PUT', '/api/admin/integrations', s)
      if (r.status !== 200) throw new Error(`switch: ${r.status} ${r.text}`)
    }
  }
  const mcp = async (token: string) => {
    const client = new Client({ name: 'vihko-tests', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL('http://vihko.test/mcp'), {
      fetch: (u, init) => Promise.resolve(app.request(String(u), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean }
      const [first, ...rest] = r.content
      let data: any = null
      try { data = toolData(first?.text ?? 'null') } catch { data = first?.text }
      return { data, texts: rest.map((c) => c.text), error: r.isError === true, raw: JSON.stringify(r) }
    }
    return { client, call, close: () => client.close() }
  }
  const settle = async () => {
    history.recorder.closeAll()
    await history.recorder.settle()
  }
  const url = (path: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams(params).toString()
    return q ? `${path}?${q}` : path
  }
  const close = async () => {
    await history.close()
    index.close()
    state.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    dir, notesDir, stateDir, index, app, services, auth, keys, history, notes, indexer, runtime, workspace, users, groupList, permissions, holds, policy,
    as, admin: as('admin'), member: as('member'), other: as('other'), withKey, newKey, enable, mcp, settle, url, close,
  }
}

/** The vault of the scenario: a shared folder, each person's own, the member's diary and recipes, and notes that link across. */
export const FILES: Record<string, string | Uint8Array> = {
  // An image destination with a space is no image: written as %20.
  [PATH.list]: `---\ntags: [${TAG.home}]\nuid: ${UID.list}\n---\n# ${m.aHeading()}\n\n${m.aSentence()} [[${NAME.cake}]] [[2026-09-27]]. [[${NAME.plan}]]\n\n![](${NAME.photo.replaceAll(' ', '%20')}.png)\n`,
  [PATH.photo]: PNG,
  [PATH.diary]: `---\ntags: [${TAG.home}, ${TAG.intimate}]\n---\n# ${m.aHeading()} ${MEMBER.username}\n\n${m.aSentence()} ${WORD.diary}. [[${NAME.list}]]\n`,
  [PATH.cake]: `---\nuid: ${UID.cake}\n---\n# ${m.aHeading()} ${MEMBER.username}\n\n${m.aSentence()} ${WORD.cake}. [[${NAME.list}]]\n`,
  [PATH.memberPhoto]: PNG,
  [PATH.otherNotes]: `# ${m.aHeading()} ${OTHER.username}\n\n${m.aSentence()} ${WORD.other}.\n`,
  [PATH.adminPlan]: `# ${m.aHeading()} ${ADMIN.username}\n\n${m.aSentence()} ${WORD.admin}. [[${NAME.list}]]\n`,
  [PATH.adminPlanCased]: `# ${m.aHeading()} ${ADMIN.username}\n\n${m.aSentence()} ${WORD.admin}.\n`,
  [PATH.nobodyNote]: `# ${m.aHeading()}\n\n${m.aSentence()} ${WORD.nobody}.\n`,
  [PATH.settings]: `# ${m.aHeading()}\n\n${m.aSentence()} ${WORD.settings}. [[${NAME.list}]]\n`,
  [PATH.rootPlan]: `# ${m.aHeading()}\n\n${m.aSentence()} ${WORD.settings} ${WORD.root}.\n`,
}
