// Configuration shared by the test server and the tests.
// data.ts first: it may set the seed before anything draws from it.
import { E2E_DIR } from './data.ts'
import { mother, type NewUser } from '../../../test/mother.ts'

export { E2E_DIR }
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8094)
export const NOTES = E2E_DIR + '/notes'
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`
/** A second server, with THOTH_INTEGRATIONS=off: the API and MCP locked by the server's administrator. */
export const LOCKED_PORT = Number(process.env.E2E_LOCKED_PORT ?? E2E_PORT + 2) // +1 is the acceptance server's (8095)
export const LOCKED_URL = process.env.E2E_LOCKED_URL ?? `http://127.0.0.1:${LOCKED_PORT}`
/** Another origin for "external" images: a server in the test process (images.spec.ts). */
export const EXTERNAL_PORT = Number(process.env.E2E_EXTERNAL_PORT ?? 8132)
/** THOTH_PUBLIC_URL of the main test server: OAuth exists there (while MCP is on). Nothing answers at it; the specs use BASE_URL. */
export const PUBLIC_URL = 'https://thoth.e2e.test'

/** The people of the servers, the same in them (serve.ts) and in the specs: one scope for both, not a spec's. */
const people = mother('e2e: the people of the servers')
/** The admin of the servers. */
export const ADMIN = people.aUser({ role: 'admin' })
/** A member, who edits everything (ROOT_GRANTS). */
export const MEMBER = people.aUser({ role: 'member' })
export const USERS: NewUser[] = [ADMIN, MEMBER]
export type Level = 'read' | 'comment' | 'edit' | 'manage'
export type Grants = Record<string, Level>
/**
 * The grants at the root every spec runs under (D-038): the admin manages
 * it and the member edits it, so both see everything.
 */
export const ROOT_GRANTS: Grants = { [ADMIN.username]: 'manage', [MEMBER.username]: 'edit' }

/**
 * The `permissions:` section of thoth.yaml: the root with ROOT_GRANTS, plus
 * (or changed by) `grants`; then `rules`, more folders with their grants.
 */
export function permissionsSection(grants: Grants = {}, rules: Record<string, Grants> = {}): string {
  const map = (g: Grants) => `{ ${Object.entries(g).map(([s, l]) => `${JSON.stringify(s)}: ${l}`).join(', ')} }`
  return 'permissions:\n  "":\n    grants: ' + map({ ...ROOT_GRANTS, ...grants }) + '\n'
    + Object.entries(rules).map(([folder, g]) => `  ${JSON.stringify(folder)}:\n    grants: ${map(g)}\n`).join('')
}

/** The permissions every spec runs under, in thoth.yaml. A spec that writes thoth.yaml keeps them (`writeWorkspace`, `usePermissions`). */
export const PERMISSIONS = permissionsSection()

/**
 * The values of a spec: `const m = specMother(import.meta.url)`. The specs
 * share one server, where a deleted user's name stays reserved (D-038.8): a
 * test retried in a new worker draws from another lane, so it never repeats
 * what the failed attempt created. The same seed gives the same values; a
 * run with a fixed seed again needs a fresh server (serve.ts starts clean).
 */
export const specMother = (url: string) => mother(url, { lane: process.env.TEST_WORKER_INDEX ?? 0 })
