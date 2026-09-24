// Reescritura de enlaces al mover o renombrar una nota (D-018). Regla: un
// renombrado nunca cambia el destino de un enlace existente. Para cada enlace
// que resolvía a una nota, se comprueba a dónde resuelve después del cambio; si
// difiere, se reescribe con la forma más corta que siga apuntando a su destino.
import { posix } from 'node:path'
import { extract, type LinkIndex, type LinkRef } from '@thoth/core'

export interface Replacement {
  from: number
  to: number
  text: string
}

/**
 * Reemplazos para que los enlaces de una nota conserven su destino.
 * `srcBefore`/`srcAfter`: ruta de la nota antes y después (difieren si es la nota movida).
 * `map`: destino antes → destino después (la nota movida cambia de ruta; el resto no).
 */
export function planRelinks(
  text: string,
  srcBefore: string,
  srcAfter: string,
  before: LinkIndex,
  after: LinkIndex,
  map: (path: string) => string,
): Replacement[] {
  const out: Replacement[] = []
  for (const link of extract(text).links) {
    const rb = before.resolve(srcBefore, link)
    if (rb.status !== 'resolved') continue
    const want = map(rb.path)
    const ra = after.resolve(srcAfter, link)
    if (ra.status === 'resolved' && ra.path === want) continue
    const raw = rewrite(link, srcAfter, want, after)
    if (raw !== null && raw !== link.raw) out.push({ from: link.from, to: link.to, text: raw })
  }
  return out
}

export function applyReplacements(text: string, reps: Replacement[]): string {
  let out = text
  for (const r of [...reps].sort((a, b) => b.from - a.from)) out = out.slice(0, r.from) + r.text + out.slice(r.to)
  return out
}

const stripMd = (p: string) => p.replace(/\.md$/i, '')

function rewrite(link: LinkRef, src: string, want: string, index: LinkIndex): string | null {
  if (link.kind === 'markdown') {
    const open = link.raw.indexOf('](')
    const url = link.raw.slice(open + 2, -1)
    const hash = url.indexOf('#')
    const rel = posix.relative(posix.dirname(src), want)
    return link.raw.slice(0, open + 2) + rel.replace(/ /g, '%20') + (hash === -1 ? '' : url.slice(hash)) + ')'
  }
  // Wikilink: nombre, sufijos de ruta cada vez más largos y, por último, ruta absoluta.
  const parts = stripMd(want).split('/')
  const candidates = [...parts.map((_, i) => parts.slice(parts.length - 1 - i).join('/')), '/' + parts.join('/')]
  const target = candidates.find((c) => {
    const r = index.resolve(src, { kind: 'wiki', target: c, anchor: null })
    return r.status === 'resolved' && r.path === want
  })
  if (!target) return null
  const start = link.raw.indexOf(link.target, link.kind === 'embed' ? 3 : 2)
  return link.raw.slice(0, start) + target + link.raw.slice(start + link.target.length)
}
