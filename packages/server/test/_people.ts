// The two people most setups sign in: an admin and a member, new ones (the
// mother's) for every setup. A setup's thoth.yaml or files may name them:
// then the test gives a function of their usernames instead of a text.
import type { Auth, User } from '@thoth/server'
import { mother, type NewUser } from '../../../test/mother.ts'

const m = mother(import.meta.url)

/** A user of a setup: as thoth has it, and the password they sign in with. */
export type Person = User & { password: string }

/** The usernames of a setup's people, for what names them. */
export interface Names { admin: string; member: string }

/** A value, or one made from the people's usernames. */
export type ByNames<T> = T | ((names: Names) => T)

export function byNames<T>(v: ByNames<T>, names: Names): T {
  return typeof v === 'function' ? (v as (n: Names) => T)(names) : v
}

/** A new admin and a new member, not created yet. */
export function newPeople(): { admin: NewUser; member: NewUser } {
  return { admin: m.aUser({ role: 'admin' }), member: m.aUser({ role: 'member' }) }
}

/** Creates someone in `auth` and keeps their password with them. */
export async function create(auth: Auth, u: NewUser): Promise<Person> {
  return { ...(await auth.createUser(u.username, u.password, u.role)), password: u.password }
}
