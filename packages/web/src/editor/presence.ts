// Presencia: quién tiene la nota abierta, cada persona con su color (userColor.ts).
// Por la red viaja el tono; cada navegador lo pinta con su tema.
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import { currentTheme, onThemeChange } from '../theme.ts'
import { distinctHue, userColor } from '../userColor.ts'

type Awareness = NonNullable<HocuspocusProvider['awareness']>
type PeerState = { user?: { name?: string; hue?: number } }

/**
 * Anuncia a la persona en la nota. Su tono se separa del de quienes tienen un
 * clientID menor, y solo de esos: así nadie depende de quien llega después y los
 * tonos no oscilan. El color del cursor (y-codemirror necesita un hex) se rehace
 * al cambiar de tema.
 */
export function announce(awareness: Awareness, user: { id: string; username: string }): () => void {
  const choose = () => {
    const before: number[] = []
    for (const [id, s] of awareness.getStates()) {
      const hue = (s as PeerState).user?.hue
      if (id < awareness.clientID && typeof hue === 'number') before.push(hue)
    }
    const hue = distinctHue(user.id, before)
    const color = userColor(hue, currentTheme())
    const cur = (awareness.getLocalState() as { user?: { hue?: number; color?: string } } | null)?.user
    if (cur?.hue === hue && cur.color === color) return
    awareness.setLocalStateField('user', { name: user.username, hue, color, colorLight: color + '33' })
  }
  choose()
  awareness.on('change', choose)
  const offTheme = onThemeChange(choose)
  return () => {
    awareness.off('change', choose)
    offTheme()
  }
}

export interface Peer { name: string; hue: number }

export function usePresence(provider: HocuspocusProvider | undefined): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([])
  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness) return
    const read = () => {
      const byName = new Map<string, number>()
      for (const s of awareness.getStates().values()) {
        const u = (s as PeerState).user
        if (u?.name && typeof u.hue === 'number' && !byName.has(u.name)) byName.set(u.name, u.hue)
      }
      setPeers([...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, hue]) => ({ name, hue })))
    }
    read()
    awareness.on('change', read)
    return () => awareness.off('change', read)
  }, [provider])
  return peers
}
