// Presencia: quién tiene la nota abierta, con un color estable por usuario.
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'

/** Colores de usuario del sistema de diseño (tokens user-*). */
const USER_TOKENS = ['--user-1', '--user-2']

function hash(s: string) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) | 0
  return Math.abs(h)
}

export function userToken(username: string) {
  return USER_TOKENS[hash(username) % USER_TOKENS.length]!
}

/** Valor real del color (el cursor remoto de y-codemirror necesita un hex, no una variable). */
function tokenValue(token: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || '#96611A'
}

type Awareness = NonNullable<HocuspocusProvider['awareness']>
type PeerState = { user?: { name?: string; token?: string } }

/**
 * Anuncia al usuario en la nota con un color que no tenga otro de los presentes.
 * Si dos coinciden (llegaron a la vez), cede el de clientID mayor. Con más personas
 * que colores, se repiten.
 */
export function announce(awareness: Awareness, username: string): () => void {
  const choose = () => {
    const mine = (awareness.getLocalState() as PeerState | null)?.user?.token
    const taken = new Set<string>()
    let clash = false
    for (const [id, s] of awareness.getStates()) {
      if (id === awareness.clientID) continue
      const token = (s as PeerState).user?.token
      if (!token) continue
      taken.add(token)
      if (token === mine && id < awareness.clientID) clash = true
    }
    if (mine && !clash) return
    const preferred = userToken(username)
    const token = !taken.has(preferred) ? preferred : USER_TOKENS.find((t) => !taken.has(t)) ?? preferred
    if (token === mine) return
    const color = tokenValue(token)
    awareness.setLocalStateField('user', { name: username, token, color, colorLight: color + '33' })
  }
  choose()
  awareness.on('change', choose)
  return () => awareness.off('change', choose)
}

export interface Peer { name: string; token: string }

export function usePresence(provider: HocuspocusProvider | undefined): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([])
  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness) return
    const read = () => {
      const byName = new Map<string, string>()
      for (const s of awareness.getStates().values()) {
        const u = (s as PeerState).user
        if (u?.name && !byName.has(u.name)) byName.set(u.name, u.token ?? userToken(u.name))
      }
      setPeers([...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, token]) => ({ name, token })))
    }
    read()
    awareness.on('change', read)
    return () => awareness.off('change', read)
  }, [provider])
  return peers
}
