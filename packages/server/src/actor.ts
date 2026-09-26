// Who makes a change and why. Every write carries its actor; the history
// records it with each version (D-016, D-033). Reasons are codes with their
// data, never text: the UI words them (D-025).

/**
 * Who makes a change. `id` is the stable id of the user (state.db), never the
 * name: names change, and the history resolves the current one when asked.
 */
export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; onBehalfOf: string }
  | { kind: 'system'; reason: Reason }

/**
 * Why a change was made. `by` is who asked for the operation the system
 * carried out.
 * - `note_moved`, `folder_moved`: links rewritten because `by` moved or
 *   renamed a note or a folder.
 * - `links_after_external_move`: «Update links» after notes were moved outside
 *   thoth (D-031.4).
 * - `alias_added`: the safety alias of a rename (D-018), because some link
 *   couldn't be rewritten.
 * - `restored`: a version of the note (`id`, from `at`) brought back from the
 *   history. `trash_restored`: a note brought back from the trash.
 * - `reverted`: what version `id` (from `at`) changed, undone on the note as
 *   it was (history/revert.ts).
 * - `history_enabled`, `history_resumed`: what was in the folder when the
 *   history started, or changed while it was off.
 * - `recovered`: text thoth wrote back from its own copy (the collaboration
 *   hub) whose typists it doesn't know.
 * - `follow_external_move`, `keep_copy`, `crash_recovery`: the hub's own
 *   sessions; they never write a version.
 */
export type Reason =
  | { code: 'note_moved'; from: string; to: string; by: Actor }
  | { code: 'folder_moved'; from: string; to: string; by: Actor }
  | { code: 'links_after_external_move'; moves: { from: string; to: string }[]; by: Actor }
  | { code: 'alias_added'; alias: string; from: string; to: string; by: Actor }
  | { code: 'restored'; id: string; at: string }
  | { code: 'trash_restored'; id: string }
  | { code: 'reverted'; id: string; at: string }
  | { code: 'history_enabled' }
  | { code: 'history_resumed' }
  | { code: 'recovered' }
  | { code: 'follow_external_move' }
  | { code: 'keep_copy' }
  | { code: 'crash_recovery' }

export type ReasonCode = Reason['code']

/**
 * An author as the history keeps it: an actor without its reason, or
 * `external` (a change made outside thoth). As text (`authorKey`) it is what
 * the `Thoth-Actor` trailer holds: `user <id>`, `agent <keyId> <userId>`,
 * `system`, `external`.
 */
export type Author =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; onBehalfOf: string }
  | { kind: 'system' }
  | { kind: 'external' }

export function authorOf(a: Actor): Author {
  if (a.kind === 'user') return { kind: 'user', id: a.id }
  if (a.kind === 'agent') return { kind: 'agent', id: a.id, onBehalfOf: a.onBehalfOf }
  return { kind: 'system' }
}

export function authorKey(a: Author): string {
  if (a.kind === 'user') return `user ${a.id}`
  if (a.kind === 'agent') return `agent ${a.id} ${a.onBehalfOf}`
  return a.kind
}

/** The author in a `Thoth-Actor` trailer; null if it isn't one. */
export function parseAuthorKey(key: string): Author | null {
  const [kind, id, onBehalfOf, ...rest] = key.trim().split(' ')
  if (rest.length) return null
  if (kind === 'user' && id && !onBehalfOf) return { kind, id }
  if (kind === 'agent' && id && onBehalfOf) return { kind, id, onBehalfOf }
  if ((kind === 'system' || kind === 'external') && !id) return { kind }
  return null
}

/** A reason as the `Thoth-Reason` trailer keeps it: JSON, with `by` as an author key. */
export function reasonJson(r: Reason): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r }
  if ('by' in r) out.by = authorKey(authorOf(r.by))
  return out
}
