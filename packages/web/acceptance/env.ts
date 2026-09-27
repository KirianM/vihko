// Configuration shared by the acceptance server and its browser specs.
// data.ts first: it may set the seed before anything draws from it.
import { ACC_DIR } from './data.ts'
import { mother, type NewUser } from '../../../test/mother.ts'

export { ACC_DIR }
export const ACC_PORT = Number(process.env.ACC_PORT ?? 8095)
export const NOTES = ACC_DIR + '/notes'
export const BASE_URL = process.env.ACC_BASE_URL ?? `http://127.0.0.1:${ACC_PORT}`
/** The people of the server, the same in it (serve.ts) and in the specs: one scope for both. */
const people = mother('web acceptance: the people of the server')
export const ADMIN = people.aUser({ role: 'admin' })
export const MEMBER = people.aUser({ role: 'member' })
export const USERS: NewUser[] = [ADMIN, MEMBER]
/** Both users see everything (D-038: a member reads only what is granted). */
export const PERMISSIONS = `permissions:\n  "":\n    grants: { ${JSON.stringify(ADMIN.username)}: manage, ${JSON.stringify(MEMBER.username)}: edit }\n`
