// Deterministic generator of a realistic vault for the acceptance tests (M1):
// ~1,000 notes in nested folders, frontmatter of every kind, wikilinks and
// Markdown links (ambiguous and broken ones included), tags, headings with
// anchors, images, Unicode and NFD names, and a copy of testdata/vault as
// the edge-case seed. Same seed and size = same bytes.
//
// Also a command: node packages/server/test/acceptance/_vault.ts <dir> [notes] [seed]
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { mother } from '../../../../test/mother.ts'

export const EDGE_VAULT = fileURLToPath(new URL('../../../../testdata/vault', import.meta.url))
/** Who signs the comments some notes carry (a username of the mother's; nobody has to exist). */
const COMMENTER = mother(import.meta.url).aUsername()

export interface VaultOptions {
  notes?: number
  seed?: number
}

export interface Vault {
  dir: string
  /** Generated notes (relative paths, as written on disk), without the edge-case seed. */
  notes: string[]
  /** The heavily linked note: the rename test moves it. */
  hub: string
  /** Another note with the name the hub is renamed to (links to it must not be stolen). */
  trap: string
  /** Where the rename test moves the hub. */
  hubTarget: string
  /** Rare words planted in one note each: searching for them must find that note first. */
  markers: { word: string; path: string }[]
  /** Plain notes with a valid frontmatter, fit for editing tests. */
  editable: string[]
}

// --- Random numbers: mulberry32, seeded --------------------------------------

export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!
  const chance = (p: number) => next() < p
  return { next, int, pick, chance }
}

// --- Vocabulary ------------------------------------------------------------

const WORDS = (
  'el la los las un una de del en con por para sobre entre sin como cuando donde porque pero también ' +
  'sistema proyecto nota idea plan tarea reunión decisión cambio servidor red disco copia datos índice ' +
  'búsqueda enlace carpeta archivo usuario equipo semana mes año día mañana tarde revisión borrador ' +
  'versión despliegue contenedor volumen imagen registro alerta error fallo prueba medida resultado ' +
  'café té receta cocina horno azúcar harina aceite sal limón naranja pimiento cebolla ajo tomate ' +
  'montaña río camino viaje tren avión hotel museo ciudad pueblo playa invierno verano otoño primavera ' +
  'lectura libro capítulo autor cita resumen pregunta respuesta objetivo métrica hábito entrenamiento ' +
  'kubernetes proxy raid nfs sqlite postgres docker git yjs markdown frontmatter wikilink ' +
  'rápido lento nuevo viejo grande pequeño claro oscuro difícil fácil útil raro común ' +
  'pingüino cigüeña ñandú corazón canción acción razón algún según después través'
).split(' ')

// Invented people whose names cover accents, «ñ», «ø», «ö», «ß», «ł» and one-word names (the edge cases, kept literal).
const PEOPLE = ['José Álvarez', 'Zoë Martín', 'Íñigo Ruiz', 'Ana Peñalver', 'Chloé Dubois', 'Łukasz Nowak', 'Søren Vestbjerg',
  'María José', 'Sölvi', 'Renée Leclerc', 'Nuño Castaño', 'Ángela Ortiz', 'François Muñoz', 'Jürgen Groß', 'Ximena Úbeda',
  'Tadeo Sáenz', 'Lucía Fernández', 'Marta Góngora', 'Raúl Díaz', 'Elena Ibáñez']
const RECIPES = ['Café con leche', 'Crème brûlée', 'Paella valenciana', 'Tortilla de patatas', 'Gazpacho andaluz', 'Piñones tostados',
  'Açaí bowl', 'Pâté de campaña', 'Jalapeños rellenos', 'Ñoquis de calabaza', 'Crêpes', 'Smørrebrød', 'Bacalao al pil-pil',
  'Salmorejo', 'Pan de muerto', 'Crema catalana', 'Fideuà', 'Häagen helado casero', 'Migas', 'Cocido madrileño']
const PROJECTS = ['atlas', 'boreal', 'cénit', 'delta', 'eólica', 'faro', 'gaia', 'hélice', 'iris', 'júpiter', 'kairos', 'lumen']
const TOPICS: Record<string, string[]> = {
  informática: ['redes', 'bases de datos', 'seguridad', 'sistemas distribuidos', 'compiladores'],
  ciencia: ['física', 'biología', 'química', 'astronomía'],
  humanidades: ['historia', 'filosofía', 'lingüística'],
  deporte: ['fuerza', 'resistencia', 'nutrición'],
  música: ['armonía', 'guitarra', 'producción'],
}
const HEADINGS = ['Contexto', 'Objetivos', 'Decisiones', 'Próximos pasos', 'Notas', 'Referencias', 'Riesgos', 'Resumen', 'Detalles', 'Preguntas abiertas']
// Names repeated in several folders: [[Plan]], [[Tareas]]… resolve by proximity or stay ambiguous.
const SHARED_NAMES = ['Plan', 'Tareas', 'Notas', 'README', 'Ideas', 'Diseño']
const TAGS = ['proyecto', 'idea', 'pendiente', 'lectura', 'hogar', 'hogar/red', 'hogar/almacenamiento', 'receta', 'persona', 'diario', 'área/salud', 'área/trabajo', 'música', 'ciencia']

const HUB = 'conceptos/Arquitectura.md'
const HUB_HEADINGS = ['Componentes', 'Flujo de datos', 'Decisiones de diseño']
const HUB_TARGET = 'archivo/Diseño.md'

// --- Helpers ---------------------------------------------------------------

const baseName = (p: string) => posix.basename(p).replace(/\.md$/, '')
const encodeDest = (p: string) => p.split('/').map((s) => encodeURIComponent(s).replace(/%2F/g, '/')).join('/')
const relative = (from: string, to: string) => posix.relative(posix.dirname(from), to) || posix.basename(to)

/** A valid solid-colour PNG (the edge vault's is just the signature). */
function png(seed: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(4, 0)
  ihdr.writeUInt32BE(4, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.from([0, ...Array.from({ length: 4 }, () => [seed & 255, (seed >> 3) & 255, 90]).flat()])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat([row, row, row, row]))), chunk('IEND', Buffer.alloc(0))])
}

interface Spec {
  path: string
  title: string
  headings: string[]
  aliases: string[]
  /** How the file is written: NFD names, CRLF, BOM. */
  nfd?: boolean
}

// --- Generator ---------------------------------------------------------------

export function generateVault(dir: string, opts: VaultOptions = {}): Vault {
  const total = opts.notes ?? 1000
  const r = rng(opts.seed ?? 1)
  mkdirSync(dir, { recursive: true })
  cpSync(EDGE_VAULT, join(dir, 'edge'), { recursive: true })

  // 1. Which notes exist (paths, titles, headings), before writing any text:
  // links need to know every target.
  const specs: Spec[] = []
  const used = new Set<string>()
  const add = (path: string, extra: Partial<Spec> = {}) => {
    if (used.has(path.normalize('NFC').toLowerCase())) return
    used.add(path.normalize('NFC').toLowerCase())
    const headings = Array.from({ length: 1 + r.int(4) }, () => r.pick(HEADINGS)).filter((h, i, a) => a.indexOf(h) === i)
    specs.push({ path, title: baseName(path), headings, aliases: [], ...extra })
  }
  add(HUB, { headings: HUB_HEADINGS, aliases: ['arch', 'Diseño general'] })
  add('proyectos/cénit/Diseño.md', { headings: ['Pantallas', 'Colores'] }) // the trap: same name as HUB_TARGET
  const budget = total - 20 // room for the fixed notes at the end
  for (const p of PROJECTS) for (const n of SHARED_NAMES.slice(0, 4)) add(`proyectos/${p}/${n}.md`)
  for (const [i, name] of PEOPLE.entries()) add(`personas/${name}.md`, { nfd: i % 3 === 0, aliases: i % 4 === 0 ? [name.split(' ')[0]!] : [] })
  for (const [i, name] of RECIPES.entries()) add(`recetas/${name}.md`, { nfd: i % 2 === 0 })
  add('recetas/Café.md', { nfd: true }) // the same name as the edge vault's, in another folder
  for (const topic of Object.keys(TOPICS)) for (const sub of TOPICS[topic]!) add(`conocimiento/${topic}/${sub}/README.md`)
  // Diary: one note per day from 2025-01-01.
  const days = Math.floor(budget * 0.3)
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10)
    add(`diario/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`, { headings: ['Hecho', 'Pendiente'] })
  }
  // The rest: knowledge, project notes, archive, inbox.
  while (specs.length < budget) {
    const kind = r.int(10)
    const words = () => Array.from({ length: 1 + r.int(4) }, () => r.pick(WORDS)).join(' ')
    const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
    if (kind < 4) {
      const topic = r.pick(Object.keys(TOPICS))
      add(`conocimiento/${topic}/${r.pick(TOPICS[topic]!)}/${title(words())}.md`, { nfd: r.chance(0.1) })
    } else if (kind < 7) {
      add(`proyectos/${r.pick(PROJECTS)}/${r.chance(0.1) ? r.pick(SHARED_NAMES) : title(words())}.md`)
    } else if (kind < 9) {
      add(`archivo/${2019 + r.int(6)}/${r.chance(0.3) ? r.pick(SHARED_NAMES) : title(words())}.md`)
    } else {
      add(`Bandeja de entrada/${title(words())} (${1 + r.int(99)}).md`, { nfd: r.chance(0.2) })
    }
  }

  // 2. Frontmatter aliases on some notes, so links by alias exist.
  for (const s of specs) if (s.aliases.length === 0 && r.chance(0.05)) s.aliases.push(`${s.title} alias`)

  const hub = specs[0]!
  const markers: Vault['markers'] = []
  const editable: string[] = []
  const images: { path: string; bytes: Buffer }[] = []
  const texts = new Map<string, string>()

  // 3. Text of each note.
  const hubLinkForms = (from: string) => [
    '[[Arquitectura]]', '[[Arquitectura|la arquitectura]]', '[[arquitectura]]', `[[Arquitectura#${r.pick(HUB_HEADINGS)}]]`,
    '[[Arquitectura#Sección que no existe]]', '[[conceptos/Arquitectura]]', '[[/conceptos/Arquitectura]]', '[[arch]]',
    '[[Diseño general|el diseño]]', `[la arquitectura](${encodeDest(relative(from, HUB))})`,
    `[componentes](${encodeDest(relative(from, HUB))}#Componentes)`, '![[Arquitectura]]',
  ]
  const linkTo = (from: string, t: Spec): string => {
    const name = t.title
    const f = r.int(10)
    if (f === 0 && t.headings.length) return `[[${name}#${r.pick(t.headings)}]]`
    if (f === 1) return `[[${name}|${r.pick(WORDS)}]]`
    if (f === 2) return `[[${posix.basename(posix.dirname(t.path))}/${name}]]`
    if (f === 3) return `[${r.pick(WORDS)}](${encodeDest(relative(from, t.path))})`
    if (f === 4 && t.aliases.length) return `[[${r.pick(t.aliases)}]]`
    return `[[${name}]]`
  }
  const paragraph = (from: string, links: number) => {
    const out: string[] = []
    const n = 20 + r.int(80)
    for (let i = 0; i < n; i++) {
      out.push(r.pick(WORDS))
      if (links > 0 && r.chance(links / n)) out.push(linkTo(from, r.pick(specs)))
      if (r.chance(0.02)) out.push(`#${r.pick(TAGS)}`)
    }
    return out.join(' ') + '.'
  }

  for (const [i, s] of specs.entries()) {
    const lines: string[] = []
    // Frontmatter of every kind.
    const fm = s === hub ? 2 : r.int(9)
    const tags = Array.from({ length: r.int(3) }, () => r.pick(TAGS))
    const aliases = s.aliases.length ? `aliases: [${s.aliases.map((a) => JSON.stringify(a)).join(', ')}]` : null
    let invalid = false
    if (fm === 1) lines.push('---', `title: ${JSON.stringify(s.title)}`, `tags: [${tags.join(', ')}]`, ...(aliases ? [aliases] : []), '---')
    else if (fm === 2) lines.push('---', '# written by hand', ...(aliases ? [aliases] : []), 'tags:', ...tags.map((t) => `  - ${t}`),
      `fecha: 2025-${String(1 + r.int(12)).padStart(2, '0')}-${String(1 + r.int(28)).padStart(2, '0')}`, 'estado: borrador   # unknown key', '---')
    else if (fm === 3) lines.push('---', `uid: 01GEN${String(i).padStart(7, '0')}`, `title: '${s.title.replace(/'/g, "''")}'`, ...(aliases ? [aliases] : []), '---')
    else if (fm === 4) lines.push('---', 'resumen: |', '  línea uno', '  línea dos', 'base: &b {x: 1}', 'copia: *b', ...(aliases ? [aliases] : []), '---')
    else if (fm === 5 && i % 97 === 5) { lines.push('---', 'title: [roto', 'tags: {', '---'); invalid = true }
    else if (aliases) lines.push('---', aliases, '---')
    if (!invalid && lines.length) editable.push(s.path)

    lines.push(`# ${s.title}`, '')
    const bodyLinks = s.path.startsWith('diario/') ? 3 : 2
    for (const h of s.headings) {
      lines.push(paragraph(s.path, bodyLinks), '', `## ${h}`, '')
    }
    lines.push(paragraph(s.path, bodyLinks), '')
    if (r.chance(0.05)) lines.push(Array.from({ length: 40 }, () => paragraph(s.path, 1)).join('\n\n'), '') // a long note

    // Links that are not what they look like.
    if (r.chance(0.08)) lines.push('```', `[[Arquitectura]] and [[${r.pick(specs).title}]] inside a code block`, '#notatag', '```', '')
    if (r.chance(0.05)) lines.push('Inline code: `[[Arquitectura]]` is not a link.', '')
    if (r.chance(0.06)) lines.push(`Broken: [[Nota que no existe ${r.int(50)}]] and [nothing](nothing-${r.int(9)}.md).`, '')
    if (r.chance(0.06)) lines.push(`Ambiguous or by proximity: [[${r.pick(SHARED_NAMES)}]].`, '')
    if (r.chance(0.03)) lines.push(`<!-- @${COMMENTER} 2025-03-01T10:00Z · see [[Arquitectura]] -->`, '')
    // A note of every nine links to the hub, in one of its forms; the trap's name is linked too.
    if (s !== hub && i % 9 === 3) lines.push(`Ver ${r.pick(hubLinkForms(s.path))}.`, '')
    if (s !== hub && i % 9 === 6) lines.push(`Ver ${r.pick(hubLinkForms(s.path))} y ${r.pick(hubLinkForms(s.path))}.`, '')
    if (s !== hub && i % 23 === 7) lines.push('Pantallas en [[Diseño]].', '')
    // Images: next to the note (they travel with it) or shared.
    if (i % 90 === 11) {
      const img = posix.join(posix.dirname(s.path), `adjuntos/figura-${i}.png`)
      images.push({ path: img, bytes: png(i) })
      lines.push(`![figura ${i}](${encodeDest(relative(s.path, img))})`, '')
    }
    if (i % 90 === 44) lines.push(`![[figura compartida.png]]`, '')
    // Search markers.
    if (i % 20 === 10) {
      const word = `marcador${i.toString(36)}zq`
      markers.push({ word, path: s.nfd ? s.path.normalize('NFD') : s.path }) // as the index knows it: the name on disk
      lines.push(`Palabra rara: ${word}.`, '')
    }
    let text = lines.join('\n')
    if (s === hub) text = hubText(s, specs)
    // Line endings and BOM on a few.
    if (fm === 6) text = text.replace(/\n/g, '\r\n')
    if (fm === 7 && i % 3 === 0) text = '﻿' + text
    texts.set(s.path, text)
  }
  images.push({ path: 'conceptos/diagrama.png', bytes: png(1) }, { path: 'figura compartida.png', bytes: png(2) })

  // 4. Fixed notes that complete the cases.
  const fixed: [string, string][] = [
    ['Inicio.md', '# Inicio\n\n[[Arquitectura]] · [[Plan]] · [[Tareas]] · [[personas/José Álvarez]] · ![[figura compartida.png]]\n'],
    ['archivo/Índice del archivo.md', '# Índice del archivo\n\nPantallas en [[Diseño]] (by proximity, the trap until the hub moves here).\n'],
    ['vacía.md', ''],
    ['solo frontmatter.md', '---\ntitle: Solo frontmatter\n---\n'],
  ]
  for (const [p, t] of fixed) { specs.push({ path: p, title: baseName(p), headings: [], aliases: [] }); texts.set(p, t) }

  // 5. Write it all. NFD names are written decomposed, as macOS does.
  for (const s of specs) {
    const onDisk = s.nfd ? s.path.normalize('NFD') : s.path
    const file = join(dir, onDisk)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, texts.get(s.path)!)
  }
  for (const img of images) {
    mkdirSync(dirname(join(dir, img.path)), { recursive: true })
    writeFileSync(join(dir, img.path), img.bytes)
  }
  return {
    dir,
    notes: specs.map((s) => (s.nfd ? s.path.normalize('NFD') : s.path)).sort(),
    hub: HUB,
    trap: 'proyectos/cénit/Diseño.md',
    hubTarget: HUB_TARGET,
    markers,
    editable: editable.filter((p) => !specs.find((s) => s.path === p)?.nfd && p !== HUB),
  }
}

/** The hub links out too: relative links and names that resolve by proximity must survive its move. */
function hubText(s: Spec, specs: Spec[]): string {
  const plan = specs.find((x) => x.path === 'proyectos/atlas/Plan.md')!
  return [
    '---',
    'aliases: [arch, "Diseño general"]',
    'tags: [proyecto, arquitectura]',
    '---',
    '# Arquitectura',
    '',
    `El plan está en [el plan de atlas](${encodeDest(relative(s.path, plan.path))}) y en [[atlas/Plan]].`,
    'Diagrama propio: ![diagrama](diagrama.png). Compartida: ![[figura compartida.png]].',
    'Personas: [[José Álvarez]], [[Zoë Martín]]. Nombre repetido: [[Plan]] y [[Diseño]].',
    'Anclas propias: [[#Componentes]].',
    '',
    ...HUB_HEADINGS.flatMap((h) => [`## ${h}`, '', `Texto de ${h.toLowerCase()} con proyecto y sistema.`, '']),
  ].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, notes, seed] = process.argv.slice(2)
  if (!dir) {
    console.error('usage: node _vault.ts <dir> [notes=1000] [seed=1]')
    process.exit(2)
  }
  const v = generateVault(dir, { notes: notes ? Number(notes) : undefined, seed: seed ? Number(seed) : undefined })
  console.log(`${v.notes.length} notes (+ the edge vault in edge/) in ${dir}`)
}
