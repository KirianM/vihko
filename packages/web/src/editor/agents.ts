// Agents in an open note (M3 §6, D-012). When an agent writes to a note that
// is open, its connection to the hub publishes in the Yjs awareness
// `{ agent: { name, onBehalfOf, via } }`, and its text arrives as Yjs items
// of that connection's clientID. Here:
//
// - `useAgents`: the agents present, for the header («Claude Code · on
//   behalf of Noa», a diamond in accent, never colour alone). An agent's
//   edit is a moment, not a stay: it is shown a while after it leaves.
// - `agentMarks`: what an agent just wrote, marked with accent-soft for a few
//   seconds (the items whose clientID is an agent's). The awareness may come
//   before or after the text: items of other clients are remembered for a
//   moment in case it turns out to be an agent's.
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view'
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import type { useT } from '../i18n.tsx'

type Awareness = NonNullable<HocuspocusProvider['awareness']>

export interface AgentInfo {
  name: string
  /** Who it acts for (a name to show; empty if the hub doesn't say). */
  onBehalfOf: string
  via: 'api' | 'mcp' | 'oauth' | null
}

/** How long an agent stays in the header after its connection leaves. */
export const AGENT_LINGER_MS = 10_000
/** How long what an agent wrote stays marked. */
export const AGENT_FRESH_MS = 6_000
/** How long another client's text waits for its awareness to say it was an agent. */
const LATE_AWARENESS_MS = 3_000

/** An awareness state's agent, if it is one (checked: it comes from the network). */
export function agentOf(state: unknown): AgentInfo | null {
  const a = (state as { agent?: unknown } | null)?.agent as { name?: unknown; onBehalfOf?: unknown; via?: unknown } | undefined
  if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !a.name.trim()) return null
  // A name, or a user as the history gives it ({ id, name }).
  const who = typeof a.onBehalfOf === 'string' ? a.onBehalfOf
    : typeof (a.onBehalfOf as { name?: unknown } | null)?.name === 'string' ? (a.onBehalfOf as { name: string }).name : ''
  const via = a.via === 'api' || a.via === 'mcp' || a.via === 'oauth' ? a.via : null
  return { name: a.name.trim(), onBehalfOf: who, via }
}

/** The agents in the awareness, by clientID. */
export function agentClients(awareness: Awareness): Map<number, AgentInfo> {
  const out = new Map<number, AgentInfo>()
  for (const [id, s] of awareness.getStates()) {
    if (id === awareness.clientID) continue
    const a = agentOf(s)
    if (a) out.set(id, a)
  }
  return out
}

/** «Claude Code · on behalf of Noa», or just its name if the hub doesn't say for whom. */
export function agentLabel(t: ReturnType<typeof useT>, a: AgentInfo): string {
  return a.onBehalfOf ? t('presence.agent', { name: a.name, user: a.onBehalfOf }) : a.name
}

const agentKey = (a: AgentInfo) => `${a.name}\u0000${a.onBehalfOf}`

/** The agents in the note now or a moment ago, one per name and person, in order of arrival. */
export function useAgents(provider: HocuspocusProvider | undefined): AgentInfo[] {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness) return
    /** Each agent seen, and until when it's shown once it has left (null: still here). */
    const seen = new Map<string, { agent: AgentInfo; until: number | null }>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const publish = () => {
      const now = Date.now()
      for (const [k, s] of seen) if (s.until !== null && s.until <= now) seen.delete(k)
      setAgents([...seen.values()].map((s) => s.agent))
      clearTimeout(timer)
      const next = Math.min(...[...seen.values()].map((s) => s.until ?? Infinity))
      if (next !== Infinity) timer = setTimeout(publish, Math.max(0, next - now) + 20)
    }
    const read = () => {
      const here = new Map([...agentClients(awareness).values()].map((a) => [agentKey(a), a]))
      for (const [k, a] of here) seen.set(k, { agent: a, until: null })
      for (const [k, s] of seen) if (!here.has(k) && s.until === null) s.until = Date.now() + AGENT_LINGER_MS
      publish()
    }
    read()
    awareness.on('change', read)
    return () => { awareness.off('change', read); clearTimeout(timer) }
  }, [provider])
  return agents
}

// --- What an agent just wrote ---------------------------------------------------

interface Fresh { from: number; to: number; title: string }
const addFresh = StateEffect.define<{ batch: number; ranges: Fresh[] }>()
const dropFresh = StateEffect.define<number>()

const freshField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(addFresh)) {
        set = set.update({
          add: e.value.ranges.map((r) => Decoration.mark({ class: 'cm-agent-fresh', attributes: { title: r.title }, batch: e.value.batch }).range(r.from, r.to)),
          sort: true,
        })
      } else if (e.is(dropFresh)) {
        const batch = e.value
        set = set.update({ filter: (_f, _t, d) => d.spec.batch !== batch })
      }
    }
    return set
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Structs a client added in one transaction: its clocks [from, to). */
interface Claim { client: number; from: number; to: number }

/**
 * Where the text of the claims is now, as ranges of the document: the live
 * items (or the parts of them, if they were split) with a claimed clock.
 * Adjacent ranges of one client are joined.
 */
function place(text: Y.Text, claims: Claim[]): { from: number; to: number; client: number }[] {
  const out: { from: number; to: number; client: number }[] = []
  let pos = 0
  for (let n = text._start; n; n = n.right) {
    if (!n.countable || n.deleted) continue
    const { client, clock } = n.id
    for (const c of claims) {
      if (c.client !== client) continue
      const a = Math.max(clock, c.from)
      const b = Math.min(clock + n.length, c.to)
      if (a >= b) continue
      const from = pos + a - clock
      const to = pos + b - clock
      const last = out[out.length - 1]
      if (last && last.to === from && last.client === client) last.to = to
      else out.push({ from, to, client })
    }
    pos += n.length
  }
  return out
}

/** The clients that added structs in a transaction, with their clocks. */
function claimsOf(tr: Y.Transaction): Claim[] {
  const out: Claim[] = []
  for (const [client, to] of tr.afterState) {
    const from = tr.beforeState.get(client) ?? 0
    if (to > from) out.push({ client, from, to })
  }
  return out
}

/**
 * Marks what agents write in this note for a few seconds. `label` words an
 * agent for the mark's tooltip.
 */
export function agentMarks(text: Y.Text, awareness: Awareness | null | undefined, label: (a: AgentInfo) => string): Extension {
  if (!awareness) return []
  const plugin = ViewPlugin.define((view) => {
    let batch = 0
    let live = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    /** Other clients' writes of the last moments, in case their awareness arrives later. */
    let late: (Claim & { at: number })[] = []
    let known = new Set(agentClients(awareness).keys())

    const mark = (claims: Claim[], agents: Map<number, AgentInfo>) => {
      // After this transaction's observers: the editor has the text by then.
      queueMicrotask(() => {
        if (!live) return
        const ranges = place(text, claims)
          .filter((r) => r.to <= view.state.doc.length)
          .map((r) => ({ from: r.from, to: r.to, title: label(agents.get(r.client)!) }))
        if (ranges.length === 0) return
        const id = ++batch
        view.dispatch({ effects: addFresh.of({ batch: id, ranges }) })
        const timer = setTimeout(() => { timers.delete(timer); if (live) view.dispatch({ effects: dropFresh.of(id) }) }, AGENT_FRESH_MS)
        timers.add(timer)
      })
    }

    // Remote transactions that touch the text: an agent's is marked; anyone
    // else's is remembered for a moment. Your own typing is never looked at.
    const observe = (_event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.local) return
      const agents = agentClients(awareness)
      const now = Date.now()
      late = late.filter((l) => now - l.at < LATE_AWARENESS_MS)
      const claims = claimsOf(tr)
      const theirs = claims.filter((c) => agents.has(c.client))
      for (const c of claims) if (!agents.has(c.client) && c.client !== awareness.clientID) late.push({ ...c, at: now })
      if (theirs.length) mark(theirs, agents)
    }
    const onAwareness = () => {
      const agents = agentClients(awareness)
      const arrived = [...agents.keys()].filter((id) => !known.has(id))
      known = new Set(agents.keys())
      if (!arrived.length || !late.length) return
      const now = Date.now()
      const theirs = late.filter((l) => arrived.includes(l.client) && now - l.at < LATE_AWARENESS_MS)
      late = late.filter((l) => !theirs.includes(l))
      if (theirs.length) mark(theirs, agents)
    }
    text.observe(observe)
    awareness.on('change', onAwareness)
    return {
      destroy() {
        live = false
        text.unobserve(observe)
        awareness.off('change', onAwareness)
        for (const t of timers) clearTimeout(t)
      },
    }
  })
  return [freshField, plugin]
}
