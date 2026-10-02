// What a tab typed that never reached the note, and nothing else will
// bring there: kept here, out of any one editor, until the person saves it
// as a copy or discards it (RescueBanner.tsx). The one way out for it,
// whatever kept it from arriving: the note was moved where they can't open
// it, deleted, or changed into another generation while they were offline;
// they can't write it any more; their session ended.
//
// Also here: every open (or still sending) copy of a note that has changes
// not acknowledged, so that leaving the page with any of them asks first
// (`beforeunload`): nothing is kept in the browser beyond this tab.
//
// Framework-free except `useRescues`: collab.ts feeds it.
import { useSyncExternalStore } from 'react'
import type * as Y from 'yjs'

/**
 * Why it couldn't be delivered: `refused` (the hub opened the note again
 * from its file, and the tab's copy can't merge), `moved` (moved where it
 * can't be written, or merged badly), `movedAway` (moved where the person
 * can't open it), `gone` (deleted, or no longer theirs to read), `trashed`,
 * `readOnly` (they may no longer write it), `session` (their session ended).
 */
export type RescueWhy = 'refused' | 'moved' | 'movedAway' | 'gone' | 'trashed' | 'readOnly' | 'session'

export interface Rescue {
  id: number
  /** Whose it is: it's only ever shown to them (another person may sign in next in the tab). */
  userId: string
  /** The note it was typed in, where it was. */
  path: string
  text: string
  why: RescueWhy
}

let rescues: Rescue[] = []
let nextId = 1
let currentUser: string | null = null
const listeners = new Set<() => void>()
const changed = () => { for (const l of listeners) l() }

/** Who is signed in: what's rescued from now on is theirs. */
export function setRescueUser(id: string | null) {
  currentUser = id
}

/** Keeps `text` typed in `path` for the person to decide about. */
export function addRescue(r: Omit<Rescue, 'id' | 'userId'>) {
  if (currentUser === null) return
  rescues = [...rescues, { ...r, id: nextId++, userId: currentUser }]
  changed()
}

/** Kept as a copy, or discarded. */
export function dropRescue(id: number) {
  rescues = rescues.filter((r) => r.id !== id)
  changed()
}

/** Signing out on purpose: what was pending goes with the session. */
export function dropRescues() {
  rescues = []
  carries.clear()
  changed()
}

/** The rescues of `userId`, oldest first. */
export function useRescues(userId: string): Rescue[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => rescues).filter((r) => r.userId === userId)
}

// --- What a tab hasn't sent ---------------------------------------------------

/** Every copy of a note open in this tab (or still sending after it closed): whether it has changes the hub hasn't acknowledged. */
const live = new Set<() => boolean>()

/** Counts a copy's unsent changes for `beforeunload`; returns how to stop counting it. */
export function trackUnsent(unsent: () => boolean): () => void {
  live.add(unsent)
  return () => { live.delete(unsent) }
}

/** Whether leaving the page now loses something: unsent changes, or a rescue nobody has decided about. */
export function hasUnsaved(): boolean {
  return rescues.length > 0 || carries.size > 0 || [...live].some((u) => u())
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsaved()) return
    e.preventDefault()
    // Older browsers show the dialog only with a value set.
    e.returnValue = ''
  })
}

// --- Following a note to where it went --------------------------------------

/**
 * What a tab typed that the hub may not have when the note went elsewhere
 * (`to`) or reopened: `mine`, the tab's text then; `base`, the hub's text
 * then, when known (a move from vihko says it), so that what the tab typed
 * on top of it can be written where the note is now. The editor that opens
 * `to` takes it (`takeCarry`): what can't be written there becomes a rescue.
 */
export interface Carry { from: string; mine: string; base: string | null; why: RescueWhy }

const carries = new Map<string, Carry>()
/** A carry nobody takes (the note wasn't opened where it went) becomes a rescue after this long. */
const CARRY_MS = 15_000

export function carryTo(to: string, c: Carry) {
  carries.set(to, c)
  setTimeout(() => {
    if (carries.get(to) !== c) return
    carries.delete(to)
    addRescue({ path: c.from, text: c.mine, why: c.why })
  }, CARRY_MS)
}

export function takeCarry(path: string): Carry | null {
  const c = carries.get(path) ?? null
  carries.delete(path)
  return c
}

/**
 * Settles a carry on the note's text as the hub has it now (`text`,
 * just synced): nothing to do if it already holds the tab's text; with the
 * hub's text from then (`base`) and `writable`, what the tab typed on top of
 * it is written here when nothing changed since where it goes; otherwise
 * it's kept for the person to decide (`addRescue`). Returns whether it was written.
 */
export function settleCarry(c: Carry, text: Y.Text, writable: boolean): boolean {
  const theirs = text.toString()
  if (theirs === c.mine) return true
  if (c.base !== null && writable) {
    const mine = hull(c.base, c.mine)
    const others = hull(c.base, theirs)
    if (mine === null) return true
    // Someone changed the note since (or it came back otherwise): only apart from what the tab typed.
    if (others === null || others.to < mine.from || others.from > mine.to) {
      const shift = others !== null && others.to < mine.from ? others.insert.length - (others.to - others.from) : 0
      const at = mine.from + shift
      text.doc!.transact(() => {
        if (mine.to > mine.from) text.delete(at, mine.to - mine.from)
        if (mine.insert) text.insert(at, mine.insert)
      })
      return true
    }
  }
  addRescue({ path: c.from, text: c.mine, why: c.why })
  return false
}

/** `base[from, to)` replaced with `insert` makes `next`: from their first difference to their last; null if equal. */
function hull(base: string, next: string): { from: number; to: number; insert: string } | null {
  if (base === next) return null
  let p = 0
  while (p < base.length && p < next.length && base[p] === next[p]) p++
  let q = 0
  while (q < base.length - p && q < next.length - p && base[base.length - 1 - q] === next[next.length - 1 - q]) q++
  return { from: p, to: base.length - q, insert: next.slice(p, next.length - q) }
}
