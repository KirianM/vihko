// Who makes a change and why. Every write carries its actor; the history
// records it with each version (D-016, D-033). Reasons are codes with their
// data, never text: the UI words them (D-025).

/**
 * How an agent reached vihko: the HTTP API with a key, the MCP server with a
 * key, or an OAuth token (M3). The history keeps it with each agent author.
 */
export type Via = 'api' | 'mcp' | 'oauth'

export const VIAS: readonly Via[] = ['api', 'mcp', 'oauth']

/**
 * Who makes a change. `id` is the stable id of the user (state.db), never the
 * name: names change, and the history resolves the current one when asked.
 * An agent's `id` is its key's id; `onBehalfOf`, the key's user.
 */
export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; onBehalfOf: string; via?: Via }
  | { kind: 'system'; reason: Reason }

/**
 * Why a change was made. `by` is who asked for the operation the system
 * carried out.
 * - `note_moved`, `folder_moved`: links rewritten because `by` moved or
 *   renamed a note or a folder.
 * - `links_after_external_move`: «Update links» after notes were moved outside
 *   vihko (D-031.4).
 * - `alias_added`: the safety alias of a rename (D-018), because some link
 *   couldn't be rewritten.
 * - `links_kept`: links kept on the note they led to when `by` gave another
 *   note (`to`) their name, by creating it or adding an alias (D-056.28).
 * - `restored`: a version of the note (`id`, from `at`) brought back from the
 *   history. `trash_restored`: a note brought back from the trash.
 * - `reverted`: what version `id` (from `at`) changed, undone on the note as
 *   it was (history/revert.ts).
 * - `history_enabled`, `history_resumed`: what was in the folder when the
 *   history started, or changed while it was off.
 * - `recovered`: text vihko wrote back from its own copy (the collaboration
 *   hub) whose typists it doesn't know.
 * - `follow_external_move`, `keep_copy`, `crash_recovery`: the hub's own
 *   sessions; they never write a version.
 */
export type Reason =
  | { code: 'note_moved'; from: string; to: string; by: Actor }
  | { code: 'folder_moved'; from: string; to: string; by: Actor }
  | { code: 'links_after_external_move'; moves: { from: string; to: string }[]; by: Actor }
  | { code: 'alias_added'; alias: string; from: string; to: string; by: Actor }
  | { code: 'links_kept'; to: string; by: Actor }
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
 * `external` (a change made outside vihko). As text (`authorKey`) it is:
 * `user <id>`, `agent <keyId> <userId>` (with ` <via>` when known),
 * `system`, `external`. In a commit, the via of an agent goes in its own
 * trailer (history/trailers.ts), so `Vihko-Actor` keeps the M2 form.
 */
export type Author =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; onBehalfOf: string; via?: Via }
  | { kind: 'system' }
  | { kind: 'external' }

export function authorOf(a: Actor): Author {
  if (a.kind === 'user') return { kind: 'user', id: a.id }
  if (a.kind === 'agent') return { kind: 'agent', id: a.id, onBehalfOf: a.onBehalfOf, ...(a.via ? { via: a.via } : {}) }
  return { kind: 'system' }
}

export function authorKey(a: Author): string {
  if (a.kind === 'user') return `user ${a.id}`
  if (a.kind === 'agent') return `agent ${a.id} ${a.onBehalfOf}${a.via ? ` ${a.via}` : ''}`
  return a.kind
}

/** The author an author key names (`authorKey`); null if it isn't one. */
export function parseAuthorKey(key: string): Author | null {
  const [kind, id, onBehalfOf, via, ...rest] = key.trim().split(' ')
  if (rest.length) return null
  if (kind === 'user' && id && !onBehalfOf) return { kind, id }
  if (kind === 'agent' && id && onBehalfOf && !via) return { kind, id, onBehalfOf }
  if (kind === 'agent' && id && onBehalfOf && (VIAS as readonly string[]).includes(via!)) return { kind, id, onBehalfOf, via: via as Via }
  if ((kind === 'system' || kind === 'external') && !id) return { kind }
  return null
}

/** A reason as the `Vihko-Reason` trailer keeps it: JSON, with `by` as an author key. */
export function reasonJson(r: Reason): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r }
  if ('by' in r) out.by = authorKey(authorOf(r.by))
  return out
}
