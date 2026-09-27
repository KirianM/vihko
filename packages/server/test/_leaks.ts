// The leak scenario (m3 §3, D-014), shared by the HTTP API's leak tests and
// the MCP server's: a key limited to `proyectos/`, with a note `ai: false`
// inside it, another with a frontmatter that can't be read, a folder holding
// only a hidden note, and notes outside that link to the visible one and
// mention the hidden ones; plus a history with something to hide.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG, type setup } from './_agents.ts'

export const FILES: Record<string, string | Uint8Array> = {
  'proyectos/visible.md': '---\ntitle: Plan visible\ntags: [compartida]\n---\n# Plan visible\n\nEnlaza a [[secreto]], a [[otra]] y a [[dup]]. Palabra: turquesa.\n\n![foto](foto.png)\n',
  'proyectos/secreto.md': '---\nai: false\ntags: [compartida, clave-oculta]\n---\n# Título Zafiro\n\nZafiro escondido. Enlaza a [[visible]].\n\n![](oculta.png)\n',
  'proyectos/roto.md': '---\ntitle: [roto\n---\n# Rubí\n\nrubí junto a [[visible]]\n',
  'proyectos/a/dup.md': '# Dup A\n',
  'proyectos/b/dup.md': '# Dup B\n',
  'proyectos/solo-oculta/escondida.md': '---\nai: no\n---\n# Escondida\n',
  'proyectos/revelada.md': '---\nai: false\n---\n# Revelada\n\nÁmbar guardado.\n',
  'proyectos/foto.png': PNG,
  'proyectos/oculta.png': PNG,
  'fuera/otra.md': '---\ntags: [compartida, clave-oculta]\n---\n# Otra Esmeralda\n\nEsmeralda. Sabe de zafiro. Enlaza a [[visible]] y a [[secreto]].\n\n![](imagen.png)\n',
  'fuera/dup.md': '# Dup de fuera\n',
  'fuera/mudanza.md': '# Mudanza\n\nCuarzo de antes.\n',
  'fuera/plantilla.md': '# Plantilla\n\nÓpalo en la plantilla.\n',
  'fuera/imagen.png': PNG,
}

export const CONFIG = `daily:
  agenda:
    folder: proyectos/diario
    template: fuera/plantilla
  ajena:
    folder: fuera/diario
`

/**
 * What must never reach the key: the hidden notes' paths, titles and words,
 * the tag only they carry, the folder outside and whatever is in it.
 */
export const MARKERS = [
  'proyectos/secreto.md', 'Zafiro', 'zafiro', 'clave-oculta', 'oculta.png',
  'proyectos/roto.md', 'Rubí', 'rubí',
  'solo-oculta', 'Escondida',
  'Ámbar', 'ámbar',
  'fuera', 'Esmeralda', 'esmeralda', 'Dup de fuera', 'imagen.png', 'Cuarzo', 'Ópalo',
]

/**
 * The notes that exist and are hidden from the key, once `historyToHide`
 * has run: a request naming one of them is told so (`agent_denied`).
 */
export const HIDDEN = [
  'proyectos/secreto.md', 'proyectos/roto.md', 'proyectos/solo-oculta/escondida.md',
  'fuera/otra-nueva.md', 'fuera/dup.md', 'fuera/plantilla.md',
]

/** The markers in `shown` that the request (`asked`) didn't name itself. */
export const leaked = (shown: string, asked: string) => MARKERS.filter((m) => shown.includes(m) && !asked.includes(m))

/**
 * A history with something to hide, made by the user: edits to hidden notes
 * and outside, a note that was hidden and isn't any more, one brought in from
 * outside, and a link the system rewrote because a note outside was renamed.
 * Returns the version ids of the notes whose history matters.
 */
export async function historyToHide(h: Awaited<ReturnType<typeof setup>>) {
  const put = async (path: string, edit: (t: string) => string) => {
    const cur = await h.admin('GET', h.url('/api/note', { path }))
    const r = await h.admin('PUT', h.url('/api/note', { path }), { text: edit(cur.body.text) }, { 'if-match': `"${cur.body.etag}"` })
    assert.equal(r.status, 200, `${path}: ${r.text}`)
    await h.settle()
  }
  await put('proyectos/secreto.md', (t) => t + 'Más zafiro.\n')
  await put('fuera/otra.md', (t) => t + 'Más esmeralda.\n')
  await put('proyectos/revelada.md', () => '---\nai: true\n---\n# Revelada\n\nYa es pública.\n')
  await put('proyectos/visible.md', (t) => t + 'Otra línea.\n')
  // Written outside, then brought in: what it said outside stays there.
  await put('fuera/mudanza.md', (t) => t.replace('Cuarzo de antes.', 'Texto de ahora.'))
  assert.equal((await h.admin('POST', '/api/note/move', { from: 'fuera/mudanza.md', to: 'proyectos/mudanza.md' })).status, 200)
  // A note outside, renamed: the system rewrites the visible note's link to it.
  assert.equal((await h.admin('POST', '/api/note/move', { from: 'fuera/otra.md', to: 'fuera/otra-nueva.md' })).status, 200)
  await h.settle()
  assert.match(readFileSync(join(h.notesDir, 'proyectos/visible.md'), 'utf8'), /\[\[otra-nueva\]\]/)
  const idsOf = async (path: string) => ((await h.admin('GET', h.url('/api/history/versions', { path }))).body.versions as { id: string }[]).map((v) => v.id)
  const ids = { secret: await idsOf('proyectos/secreto.md'), revealed: await idsOf('proyectos/revelada.md'), visible: await idsOf('proyectos/visible.md') }
  assert.ok(ids.secret.length >= 2 && ids.revealed.length >= 2 && ids.visible.length >= 2)
  return ids
}
