// Configuration shared by the test server and the tests.
// data.ts first: it may set the seed before anything draws from it.
import { E2E_DIR } from './data.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mother, type NewUser } from '../../../test/mother.ts'

export { E2E_DIR }
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8094)
export const NOTES = E2E_DIR + '/notes'
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`
/** A second server, with VIHKO_INTEGRATIONS=off: the API and MCP locked by the server's administrator. */
export const LOCKED_PORT = Number(process.env.E2E_LOCKED_PORT ?? E2E_PORT + 2) // +1 is the acceptance server's (8095)
export const LOCKED_URL = process.env.E2E_LOCKED_URL ?? `http://127.0.0.1:${LOCKED_PORT}`
/** Another origin for "external" images: a server in the test process (images.spec.ts). */
export const EXTERNAL_PORT = Number(process.env.E2E_EXTERNAL_PORT ?? 8132)
/** VIHKO_PUBLIC_URL of the main test server: OAuth exists there (while MCP is on). Nothing answers at it; the specs use BASE_URL. */
export const PUBLIC_URL = 'https://vihko.e2e.test'

/** The fixed vault the test server's notes start from, in the vault's space (SPACE). */
export const VAULT_SOURCE = fileURLToPath(new URL('../../../testdata/vault', import.meta.url))

/** The people of the servers, the same in them (serve.ts) and in the specs: one scope for both, not a spec's. */
const people = mother('e2e: the people of the servers')
/** The admin of the servers. */
export const ADMIN = people.aUser({ role: 'admin' })
/** A member, who edits the vault's space (SPACE_GRANTS). */
export const MEMBER = people.aUser({ role: 'member' })
export const USERS: NewUser[] = [ADMIN, MEMBER]
export type Level = 'read' | 'comment' | 'edit' | 'manage'
export type Grants = Record<string, Level>

/**
 * The shared space the fixed vault (testdata/vault) is in (D-056): its name,
 * and its root, `spaces/<readable>-<id>`. Both people of the servers belong
 * to it; each also has their own space, `people/<username>`.
 */
export const SPACE_NAME = people.aSpaceName()
export const SPACE = `spaces/${people.aSpaceFolder(SPACE_NAME)}`
/** The vault's space on the disk. */
export const VAULT = `${NOTES}/${SPACE}`
/** A path in the vault's space: `inVault('proyectos/Plan.md')`. */
export const inVault = (path: string) => `${SPACE}/${path}`
/** A person's own space: `people/<username>`. */
export const personal = (user: { username: string }) => `people/${user.username}`

/**
 * A folder name no folder of the vault's space uses yet (neither the vault's
 * nor one already in the server's notes): for a spec that creates a folder
 * there and deletes it when it's done, which must never take a folder of the
 * vault (a seed can draw «diario» as well as any other word). `in`: another
 * folder to look in (a real path from the notes root), the vault's space by
 * default.
 */
export function freshFolder(make: () => string, opts: { in?: string } = {}): string {
  const where = opts.in ?? SPACE
  const taken = (name: string) => (where === SPACE && existsSync(join(VAULT_SOURCE, name))) || existsSync(join(NOTES, where, name))
  for (;;) {
    const name = make()
    if (!taken(name)) return name
  }
}

/**
 * The members of the vault's space every spec runs under: the admin manages
 * it and the member edits it, so both see all of it.
 */
export const SPACE_GRANTS: Grants = { [ADMIN.username]: 'manage', [MEMBER.username]: 'edit' }

/** A rule of `permissions:`: its grants, or the whole value (grants, `ai: false` or both). */
export type Rule = Grants | { grants?: Grants; ai?: false }

const ruleValue = (r: Rule): { grants?: Grants; ai?: false } =>
  Object.keys(r).length > 0 && Object.keys(r).every((k) => k === 'grants' || k === 'ai') ? r as { grants?: Grants; ai?: false } : { grants: r as Grants }

/**
 * The `permissions:` section of vihko.yaml: the vault's space with its name
 * and SPACE_GRANTS, plus (or changed by) `grants`; then `rules`, more folders
 * (real paths from the notes root) with their grants.
 */
export function permissionsSection(grants: Grants = {}, rules: Record<string, Rule> = {}): string {
  const map = (g: Grants) => `{ ${Object.entries(g).map(([s, l]) => `${JSON.stringify(s)}: ${l}`).join(', ')} }`
  const rule = (r: Rule) => {
    const v = ruleValue(r)
    return (v.grants ? `    grants: ${map(v.grants)}\n` : '') + (v.ai === false ? '    ai: false\n' : '')
  }
  return `permissions:\n  ${JSON.stringify(SPACE)}:\n    name: ${JSON.stringify(SPACE_NAME)}\n    grants: ${map({ ...SPACE_GRANTS, ...grants })}\n`
    + Object.entries(rules).map(([folder, r]) => `  ${JSON.stringify(folder)}:\n${rule(r)}`).join('')
}

/** The permissions every spec runs under, in vihko.yaml. A spec that writes vihko.yaml keeps them (`writeWorkspace`, `usePermissions`). */
export const PERMISSIONS = permissionsSection()

/**
 * The values of a spec: `const m = specMother(import.meta.url)`. The specs
 * share one server, where a deleted user's name stays reserved (D-038.8): a
 * test retried in a new worker draws from another lane, so it never repeats
 * what the failed attempt created. The same seed gives the same values; a
 * run with a fixed seed again needs a fresh server (serve.ts starts clean).
 */
export const specMother = (url: string) => mother(url, { lane: process.env.TEST_WORKER_INDEX ?? 0 })
