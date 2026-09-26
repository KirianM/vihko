// What a history commit says about itself, in trailers under a short English
// subject (for whoever looks at the repository with git):
//
//   Thoth-Actor: user 01J…            one per author (see actor.ts)
//   Thoth-Via: <keyId> api            how an agent author reached thoth (api, mcp, oauth)
//   Thoth-Reason: {"code":"note_moved","from":"a.md","to":"b.md","by":"user 01J…"}
//   Thoth-Found-At-Startup: yes       an external change found when thoth started
//   Thoth-Move: <from>\t<to>          a file (or a whole folder) renamed in this commit
//   Thoth-Restored-From: <commit>     the version a restore brought back
//
// A note's history follows its moves through `Thoth-Move`, never through
// git's similarity heuristics.
import { VIAS, authorKey, parseAuthorKey, type Author, type Via } from '../actor.ts'

export interface CommitMeta {
  /**
   * Author keys (`user <id>`, `system`…), in order. An agent's via (`agent
   * <keyId> <userId> mcp`) is written as a `Thoth-Via` trailer next to its
   * `Thoth-Actor`, which keeps the form older versions read.
   */
  authors: string[]
  /** The reason as JSON, `by` as an author key; null for none. */
  reason: Record<string, unknown> | null
  foundAtStartup: boolean
  moves: { from: string; to: string }[]
  restoredFrom: string | null
}

export function formatMessage(subject: string, meta: CommitMeta): string {
  const lines = [subject.replace(/\s+/g, ' ').trim() || 'Change', '']
  for (const key of meta.authors) {
    const a = parseAuthorKey(key)
    if (a?.kind === 'agent' && a.via) {
      lines.push(`Thoth-Actor: ${authorKey({ kind: 'agent', id: a.id, onBehalfOf: a.onBehalfOf })}`)
      lines.push(`Thoth-Via: ${a.id} ${a.via}`)
    } else lines.push(`Thoth-Actor: ${key}`)
  }
  if (meta.reason) lines.push(`Thoth-Reason: ${JSON.stringify(meta.reason)}`)
  if (meta.foundAtStartup) lines.push('Thoth-Found-At-Startup: yes')
  for (const m of meta.moves) lines.push(`Thoth-Move: ${m.from}\t${m.to}`)
  if (meta.restoredFrom) lines.push(`Thoth-Restored-From: ${meta.restoredFrom}`)
  return lines.join('\n') + '\n'
}

export interface ParsedMessage extends CommitMeta {
  subject: string
  /** The authors as values; keys that don't parse are left out. */
  parsedAuthors: Author[]
}

export function parseMessage(message: string): ParsedMessage {
  const lines = message.split('\n')
  const out: ParsedMessage = { subject: lines[0] ?? '', authors: [], parsedAuthors: [], reason: null, foundAtStartup: false, moves: [], restoredFrom: null }
  for (const line of lines.slice(1)) {
    const m = /^(Thoth-[A-Za-z-]+): ?(.*)$/.exec(line)
    if (!m) continue
    const [, key, value] = m as unknown as [string, string, string]
    if (key === 'Thoth-Actor') {
      out.authors.push(value.trim())
      const a = parseAuthorKey(value)
      if (a) out.parsedAuthors.push(a)
    } else if (key === 'Thoth-Via') {
      // Right after its agent's `Thoth-Actor`: the latest agent author with that key id and no via yet.
      const [id, via, ...rest] = value.trim().split(' ')
      if (!id || rest.length || !(VIAS as readonly string[]).includes(via ?? '')) continue
      const i = out.parsedAuthors.findLastIndex((a) => a.kind === 'agent' && a.id === id && !a.via)
      const j = out.authors.findLastIndex((k) => { const a = parseAuthorKey(k); return a?.kind === 'agent' && a.id === id && !a.via })
      if (i < 0 || j < 0) continue
      const agent = { ...(out.parsedAuthors[i] as Extract<Author, { kind: 'agent' }>), via: via as Via }
      out.parsedAuthors[i] = agent
      out.authors[j] = authorKey(agent)
    } else if (key === 'Thoth-Reason') {
      try {
        const r = JSON.parse(value) as unknown
        if (r && typeof r === 'object' && typeof (r as { code?: unknown }).code === 'string') out.reason = r as Record<string, unknown>
      } catch { /* not ours: ignored */ }
    } else if (key === 'Thoth-Found-At-Startup') out.foundAtStartup = value.trim() === 'yes'
    else if (key === 'Thoth-Move') {
      const tab = value.indexOf('\t')
      if (tab > 0) out.moves.push({ from: value.slice(0, tab), to: value.slice(tab + 1) })
    } else if (key === 'Thoth-Restored-From') out.restoredFrom = value.trim() || null
  }
  return out
}

/** Where `path` was before `moves` (a file renamed, or a folder that holds it); null if none of them brought it here. */
export function movedFrom(path: string, moves: readonly { from: string; to: string }[]): string | null {
  for (const m of moves) {
    if (m.to === path) return m.from
    if (path.startsWith(m.to + '/')) return m.from + path.slice(m.to.length)
  }
  return null
}
