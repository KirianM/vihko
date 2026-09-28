// What `npm run ci` hands a pull request's code: whether it runs at all, and
// the environment its processes get. scripts/ci.ts asks GitHub and applies
// these; they are pure (the GitHub answer is an argument) so test/ci-guard.test.ts
// checks them without GitHub.
//
// A pull request's code (its tests, its npm scripts, its Dockerfile) runs on
// this machine as the person running the CI. So a pull request runs only when
// its author has write access to the repository (who could push that code to
// main anyway), or when that person says so with --trust, having read it.
// And no job gets this process's credentials through its environment: no
// GitHub token, no SSH agent, a home folder of its own (so no ~/.config/gh,
// ~/.ssh, ~/.npmrc or ~/.docker/config.json found by default). That is not a
// sandbox: the code still runs as this user and can reach Docker, which is
// why the first check is the one that protects.

/** How `gh` answered: whether it succeeded, and what it printed. */
export interface Answer { ok: boolean; out: string; err: string }

/** Whether a pull request's code runs, and why, told in words. */
export interface Verdict { run: boolean; why: string }

/** A GitHub user's login. An app's (`app/dependabot`) is not one, and has no collaborator permission. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** GitHub's `permission` of a collaborator with write access (a maintainer's is `write` there too). */
const WRITERS = new Set(['admin', 'write'])

/**
 * The GitHub API path that says what access `login` has to the repository
 * (`gh api` fills in `{owner}/{repo}`), or null for a login that isn't a
 * user's, such as an app's.
 */
export function permissionPath(login: string): string | null {
  return LOGIN.test(login) ? `repos/{owner}/{repo}/collaborators/${login}/permission` : null
}

/**
 * Whether pull request `number` by `author` runs: when GitHub's `answer` to
 * permissionPath says the author has write access, or with `trust` (--trust).
 * `answer` is null when there was nothing to ask (see permissionPath).
 */
export function pullRequestVerdict(number: number, author: string, answer: Answer | null, trust: boolean): Verdict {
  let who: string
  if (answer === null) who = 'which is not a user account (an app, such as Dependabot)'
  else if (!answer.ok) who = `whose access could not be checked (gh: ${answer.err.trim() || 'failed'})`
  else {
    let permission: unknown
    try { permission = (JSON.parse(answer.out) as { permission?: unknown }).permission } catch {}
    if (typeof permission !== 'string') who = `whose access could not be checked (GitHub answered ${JSON.stringify(answer.out.slice(0, 200))})`
    else if (WRITERS.has(permission)) return { run: true, why: `#${number} is by @${author}, who has ${permission} access to the repository` }
    else who = `who has ${permission === 'none' ? 'no' : permission} access to the repository, not write`
  }
  if (trust) return { run: true, why: `#${number} is by @${author}, ${who}: it runs because of --trust` }
  return {
    run: false,
    why: `refused: #${number} is by @${author}, ${who}.\n`
      + `Its code (tests, npm scripts, Dockerfile) would run on this machine as you, with your files and your Docker.\n`
      + `Read its changes first; to run it anyway, add --trust.`,
  }
}

/**
 * Variables of this process that the jobs get too: the locale and time zone,
 * and how to reach Docker and the network. Nothing else: no tokens (GH_TOKEN,
 * GITHUB_TOKEN, NPM_TOKEN…), no agents' sockets (SSH_AUTH_SOCK,
 * XDG_RUNTIME_DIR), no home folder, no git or npm settings.
 */
const PASSED = new Set([
  'LANG', 'LANGUAGE', 'TZ',
  'DOCKER_HOST',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
])
const passed = (name: string) => PASSED.has(name) || /^LC_[A-Z]+$/.test(name)

/**
 * The environment of a job's processes: the few variables of `parent` it
 * needs (see PASSED), and `own` (PATH, HOME, TMPDIR, the ports…), which wins.
 */
export function jobEnvironment(parent: Record<string, string | undefined>, own: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && passed(k)) env[k] = v
  return { ...env, ...own }
}
