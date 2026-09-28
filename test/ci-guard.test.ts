// What `npm run ci` hands a pull request's code (scripts/ci-guard.ts): it
// runs only when GitHub says its author can write to the repository, or with
// --trust; and its processes never get this process's credentials. GitHub's
// answers are made up here: these tests never ask it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Answer, jobEnvironment, permissionPath, pullRequestVerdict } from '../scripts/ci-guard.ts'
import { mother } from './mother.ts'

const m = mother(import.meta.url)
/** A GitHub login: letters, digits and hyphens, at most 39, not starting with one. */
const aLogin = () => m.anId().replace(/_+/g, '-').slice(0, 39)
const aNumber = () => m.faker.number.int({ min: 1, max: 5000 })
/** An absolute path nothing else in this file has. */
const aPath = () => `/${m.anId()}/${m.anId()}`
const aLocale = () => m.faker.helpers.arrayElement(['C.UTF-8', 'es_ES.UTF-8', 'en_GB.UTF-8', 'fi_FI.UTF-8', 'pt_BR.UTF-8'])
/** What `gh api repos/{owner}/{repo}/collaborators/<login>/permission` prints. */
const permission = (p: string): Answer => ({ ok: true, out: JSON.stringify({ permission: p, role_name: p, user: { login: aLogin() } }), err: '' })

test('a pull request by someone with write access runs, and says so', () => {
  for (const access of ['admin', 'write']) {
    const [number, author] = [aNumber(), aLogin()]
    const v = pullRequestVerdict(number, author, permission(access), false)
    assert.equal(v.run, true, access)
    assert.match(v.why, new RegExp(`#${number} is by @${author}, who has ${access} access`))
  }
})

test("a pull request by someone without write access is refused, saying why and how to run it anyway", () => {
  for (const access of ['read', 'triage', 'none']) {
    const [number, author] = [aNumber(), aLogin()]
    const v = pullRequestVerdict(number, author, permission(access), false)
    assert.equal(v.run, false, access)
    assert.match(v.why, /^refused: /)
    assert.ok(v.why.includes(`#${number}`) && v.why.includes(`@${author}`), v.why)
    assert.match(v.why, access === 'none' ? /no access/ : new RegExp(`${access} access`))
    assert.match(v.why, /--trust/)
  }
})

test('when GitHub cannot say (an error, an unexpected answer, an app as the author), the pull request is refused', () => {
  const error = m.aSentence()
  const cases: [Answer | null, string][] = [
    [{ ok: false, out: '', err: error }, `could not be checked (gh: ${error})`],
    [{ ok: true, out: m.aSentence(), err: '' }, 'could not be checked'],
    [{ ok: true, out: JSON.stringify({ role_name: 'write' }), err: '' }, 'could not be checked'],
    [null, 'not a user account'],
  ]
  for (const [answer, why] of cases) {
    const v = pullRequestVerdict(aNumber(), aLogin(), answer, false)
    assert.equal(v.run, false)
    assert.ok(v.why.startsWith('refused: ') && v.why.includes(why), v.why)
  }
})

test('--trust runs any pull request, and the reason says it was --trust', () => {
  for (const answer of [permission('read'), permission('none'), { ok: false, out: '', err: m.aSentence() }, null]) {
    const author = aLogin()
    const v = pullRequestVerdict(aNumber(), author, answer, true)
    assert.equal(v.run, true)
    assert.match(v.why, new RegExp(`@${author}, .*: it runs because of --trust$`))
  }
})

test("GitHub is asked about users only: an app's login, or anything that isn't a login, gets no path", () => {
  const login = aLogin()
  assert.equal(permissionPath(login), `repos/{owner}/{repo}/collaborators/${login}/permission`)
  for (const other of [`app/${aLogin()}`, `${aLogin()}/../${aLogin()}`, '', `-${aLogin()}`, `${aLogin()}?${aLogin()}`, 'x'.repeat(40)]) {
    assert.equal(permissionPath(other), null, other)
  }
})

test("a job's environment has no credentials, agents or home of the parent's, and the variables it needs", () => {
  const passed = {
    LANG: aLocale(), LC_ALL: aLocale(), LC_TIME: aLocale(), TZ: m.faker.location.timeZone(),
    DOCKER_HOST: `unix://${aPath()}/docker.sock`,
    HTTPS_PROXY: `http://${m.aHost()}:${m.faker.internet.port()}`, no_proxy: m.aHost(),
    NODE_EXTRA_CA_CERTS: `${aPath()}.pem`,
  }
  const tokens = {
    GH_TOKEN: m.aSecret(), GITHUB_TOKEN: m.aSecret(), GH_ENTERPRISE_TOKEN: m.aSecret(), NPM_TOKEN: m.aSecret(),
    [`${m.anId().toUpperCase().replace(/-/g, '_')}_API_KEY`]: m.aSecret(),
  }
  const withheld = {
    ...tokens,
    SSH_AUTH_SOCK: `${aPath()}/agent.${aNumber()}`, SSH_AGENT_PID: String(aNumber()),
    GPG_AGENT_INFO: aPath(), XDG_RUNTIME_DIR: aPath(), XDG_CONFIG_HOME: aPath(),
    HOME: aPath(), USER: m.aUsername(), DOCKER_CONFIG: aPath(),
    GIT_DIR: aPath(), GIT_CONFIG_GLOBAL: aPath(),
    NODE_OPTIONS: `--require ${aPath()}.js`, npm_config_userconfig: aPath(),
    VIHKO_TEST_SEED: String(aNumber()), E2E_PORT: String(aNumber()), ACCEPTANCE_DIR: aPath(),
  }
  const own = { PATH: `${aPath()}:${aPath()}`, HOME: aPath(), TMPDIR: aPath(), npm_config_cache: aPath(), CI: 'true' }
  const env = jobEnvironment({ ...withheld, ...passed, UNSET: undefined }, own)

  assert.deepEqual(env, { ...passed, ...own })
  const values = Object.values(env).join('\n')
  for (const token of Object.values(tokens)) assert.ok(!values.includes(token), 'a token reached the job')
})

test("the job's own variables win over the parent's", () => {
  const own = { TZ: m.faker.location.timeZone(), LANG: aLocale() }
  assert.deepEqual(jobEnvironment({ TZ: `${own.TZ}/${m.anId()}`, LANG: `${own.LANG}.${m.anId()}` }, own), own)
})
