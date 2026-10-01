// Spaces (D-056): where every note lives. The notes folder holds `vihko.yaml`
// and two folders whose names are fixed by the product (D-056.3):
//
//   notes/
//     vihko.yaml
//     people/<username>/          a person's personal space («My notes»)
//       .vihko/                   reserved for their note settings (D-056.16)
//     spaces/<readable>-<id>/     a shared space, such as spaces/home-7k2q9x
//
// - A path has one real form, the same for everyone: from the notes root,
//   `people/ana/trips/Rome.md`. Its space is the second-level folder: the
//   space's root.
// - A personal space is named after its owner, whose username is unique and
//   never changes. A shared space's folder is a readable part made from its
//   name when it was created (never changed afterwards) and, after the last
//   hyphen, an id of six lowercase letters and digits: its identity, so that
//   two spaces never collide and a name never reveals another space
//   (D-056.14). The name people see is kept apart, in vihko.yaml.
// - Anything else (the root itself, `people/`, `spaces/`, other top-level
//   entries, a folder under `people/` that can't be a username, one under
//   `spaces/` without an id) is in no space: nobody sees it in vihko.
//
// No imports but case folding, and nothing of Node: the UI uses it too.
import { caseFold } from './casefold.ts'

/** The folder of the personal spaces. */
export const PEOPLE = 'people'
/** The folder of the shared spaces. */
export const SPACES = 'spaces'
/** Inside a personal space, the folder reserved for that person's note settings (hidden: never indexed or served). */
export const SETTINGS_FOLDER = '.vihko'

/** How long a shared space's id is. */
export const SPACE_ID_LENGTH = 6
/** A shared space's id: six lowercase letters and digits. */
export const SPACE_ID = /^[a-z0-9]{6}$/
/** The longest a shared space's readable part is made. */
export const READABLE_MAX = 40
/** The longest a shared space's name is. */
export const SPACE_NAME_MAX = 64

/** A username: letters, digits, `.`, `_` or `-`, 2 to 64 (the server's NAME_PATTERN). */
const NAME_PATTERN = /^[\p{L}\p{N}._-]{2,64}$/u

/** A person's space: `people/<owner>`. */
export interface PersonalSpace {
  kind: 'personal'
  /** `people/<owner>`. */
  root: string
  /** The owner's username, as the folder spells it (NFC). */
  owner: string
}

/** A shared space: `spaces/<readable>-<id>`. */
export interface SharedSpace {
  kind: 'shared'
  /** `spaces/<folder>`. */
  root: string
  /** Its folder's name under `spaces/`: `home-7k2q9x`. */
  folder: string
  /** The id after the last hyphen: `7k2q9x`. */
  id: string
  /** The readable part before it: `home`. */
  readable: string
}

export type Space = PersonalSpace | SharedSpace
export type SpaceKind = Space['kind']

/** A path as a space and where in it: `inner` is relative to the space's root (`''` for the root itself). */
export interface SpacePath {
  space: Space
  inner: string
}

/**
 * Whether a name may be a user's: NAME_PATTERN, in NFC, not starting with a
 * dot (`people/.ana` would be hidden, `people/..` outside) and none of the
 * names every JavaScript object has (`__proto__`, `constructor`…), compared
 * without case: such a name would be misread as a key of the grants.
 */
export function isValidUsername(name: string): boolean {
  return NAME_PATTERN.test(name) && name === name.normalize('NFC') && !name.startsWith('.') && !OBJECT_NAMES.has(name.toLowerCase())
}

const OBJECT_NAMES = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'].map((n) => n.toLowerCase()))

/**
 * How user names and space names are compared for uniqueness: full case
 * folding (casefold.ts), as links are. On a case-insensitive volume
 * `Straße` and `STRASSE` would be one folder.
 */
export function nameKey(name: string): string {
  return caseFold(name)
}

/**
 * What's wrong with a shared space's name (the one people see), or null:
 * `empty`, `too_long` (over SPACE_NAME_MAX characters), `control_characters`
 * or `spaces_around` (a space at the start or the end). The caller keeps it
 * in NFC. Names are not unique: the folder's id tells spaces apart.
 */
export function spaceNameProblem(name: string): 'empty' | 'too_long' | 'control_characters' | 'spaces_around' | null {
  if (name.length === 0) return 'empty'
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control_characters'
  if (name.trim() !== name) return 'spaces_around'
  if ([...name].length > SPACE_NAME_MAX) return 'too_long'
  return null
}

// The combining marks of accents (Latin, Greek, Cyrillic…), removed from the
// readable part; other marks (the vowel signs of Indic scripts) are letters'.
const ACCENTS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g

/**
 * The readable part of a new shared space's folder, from its name: lowercase,
 * without accents, anything but letters and digits made a hyphen (one, never
 * at the ends), at most READABLE_MAX characters; `space` when nothing is left.
 * `Lista de la Compra!` → `lista-de-la-compra`.
 */
export function readablePart(name: string): string {
  const base = name.normalize('NFD').replace(ACCENTS, '').normalize('NFC').toLowerCase()
  const dashed = base.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  const cut = [...dashed].slice(0, READABLE_MAX).join('').replace(/-+$/, '')
  return cut === '' ? 'space' : cut
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A new random shared space id (SPACE_ID). `random`: bytes to draw it from, for tests. */
export function newSpaceId(random: Uint8Array = crypto.getRandomValues(new Uint8Array(SPACE_ID_LENGTH))): string {
  let out = ''
  // 36 doesn't divide 256: the bias (4 of 256 draws) is irrelevant for an id that only has to be unlikely to repeat.
  for (let i = 0; i < SPACE_ID_LENGTH; i++) out += ID_CHARS[random[i]! % ID_CHARS.length]
  return out
}

/**
 * The folder for a new shared space named `name`: its readable part and a new
 * id that `idTaken` says no space has yet (compared as ids: the readable part
 * never tells spaces apart). `spaces/` + it is the space's root.
 */
export function newSpaceFolder(name: string, idTaken: (id: string) => boolean, randomId: () => string = () => newSpaceId()): string {
  for (let i = 0; i < 100; i++) {
    const id = randomId()
    if (!SPACE_ID.test(id)) throw new Error(`not a space id: ${id}`)
    if (!idTaken(id)) return `${readablePart(name)}-${id}`
  }
  throw new Error('no free space id after 100 tries')
}

/** A shared space's folder name as its readable part and its id; null if it isn't one (no id after the last hyphen, or nothing before it). */
export function parseSpaceFolder(folder: string): { readable: string; id: string } | null {
  const f = folder.normalize('NFC')
  const i = f.lastIndexOf('-')
  if (i <= 0) return null
  const readable = f.slice(0, i)
  const id = f.slice(i + 1)
  if (!SPACE_ID.test(id) || readable.startsWith('.') || readable.trim() !== readable || /[\\/\u0000-\u001f\u007f]/.test(readable)) return null
  return { readable, id }
}

/** `people/<username>`. */
export function personalRoot(username: string): string {
  return `${PEOPLE}/${username.normalize('NFC')}`
}

/** `spaces/<folder>`. */
export function sharedRoot(folder: string): string {
  return `${SPACES}/${folder.normalize('NFC')}`
}

/** `people/<username>/.vihko`: the folder reserved for a person's note settings. */
export function settingsFolder(username: string): string {
  return `${personalRoot(username)}/${SETTINGS_FOLDER}`
}

/** The space a root's two segments name, or null. */
function spaceAt(top: string, second: string): Space | null {
  if (top === PEOPLE) return isValidUsername(second) ? { kind: 'personal', root: `${PEOPLE}/${second}`, owner: second } : null
  if (top === SPACES) {
    const p = parseSpaceFolder(second)
    return p ? { kind: 'shared', root: `${SPACES}/${second}`, folder: second, id: p.id, readable: p.readable } : null
  }
  return null
}

/**
 * A path (of a note, a file or a folder; from the notes root, `/`-separated,
 * in any normalization) as its space and the path inside it. Null when it is
 * in none: the root, `people`, `spaces`, anything else at the top, or a
 * second-level folder that isn't a space. The space's root itself is in it,
 * with `inner` `''`. Names are compared as written (the disk's spelling):
 * `People/ana` is in no space.
 */
export function parseSpacePath(path: string): SpacePath | null {
  const p = path.normalize('NFC')
  const first = p.indexOf('/')
  if (first <= 0) return null
  const second = p.indexOf('/', first + 1)
  const top = p.slice(0, first)
  const name = second === -1 ? p.slice(first + 1) : p.slice(first + 1, second)
  const space = spaceAt(top, name)
  if (!space) return null
  return { space, inner: second === -1 ? '' : p.slice(second + 1) }
}

/** The space a path is in, or null (parseSpacePath). */
export function spaceOf(path: string): Space | null {
  return parseSpacePath(path)?.space ?? null
}

/** The root of the space a path is in (`people/ana`, `spaces/home-7k2q9x`), or null. */
export function spaceRootOf(path: string): string | null {
  return spaceOf(path)?.root ?? null
}

/** Whether a folder is a space's root: `people/<user>` or `spaces/<readable>-<id>`. */
export function isSpaceRoot(folder: string): boolean {
  const s = parseSpacePath(folder)
  return s !== null && s.inner === ''
}

/**
 * Where a folder stands for creating something in it (a note, a file or a
 * subfolder), before anything is asked of the permissions or the disk:
 * - `inside`: in a space (its root included): the permissions decide;
 * - `outside`: the root, `people`, `spaces`, or anything in no space
 *   (`outside_space`);
 * The folder of a new space's root is `people` or `spaces`: making one is
 * never a plain folder creation (`space_root`, isSpaceRoot).
 */
export function placement(folder: string): 'inside' | 'outside' {
  return parseSpacePath(folder) === null ? 'outside' : 'inside'
}

/**
 * Whether a path is reserved by vihko: the `.vihko` folder at the root of a
 * space (a person's or a shared one, in any case) and what's in it, for its
 * settings, never notes (D-056.16, .28). Hidden too, so never indexed,
 * served nor kept in the history; this says it whatever the rule for
 * hidden names becomes.
 */
export function isReserved(path: string): boolean {
  const s = parseSpacePath(path)
  if (!s) return false
  return s.inner.split('/')[0]!.toLowerCase() === SETTINGS_FOLDER
}

/**
 * Whose a space is, as one person sees it in the UI:
 * - `mine`: their own personal space («My notes»);
 * - `person`: someone else's personal space («Ana»: a folder they share);
 * - `shared`: a shared space, by the name it has now.
 */
export type DisplaySpace =
  | { kind: 'mine'; root: string }
  | { kind: 'person'; root: string; owner: string }
  | { kind: 'shared'; root: string; id: string; name: string }

/** A real path as one person sees it (D-056, spec §5.6): the space, the folders inside it, and the name. */
export interface DisplayPath {
  space: DisplaySpace
  /** The folders from the space's root down to the note's (not the root itself). */
  folders: string[]
  /** The last segment, without `.md` for a note; `''` for a space's root. */
  name: string
}

/**
 * How `me` sees a real path (from the notes root): `people/<me>/diary/day.md`
 * is «My notes / diary / day», `spaces/home-7k2q9x/recipes/Bread.md` is
 * «<the space's name> / recipes / Bread», `people/ana/trips/Rome.md` is
 * «ana / trips / Rome». `spaceName` gives a shared space's name (the
 * readable part when it has none). Null for a path in no space. Labels and
 * separators are the UI's.
 */
export function displayPath(path: string, me: string, spaceName: (root: string) => string | null = () => null): DisplayPath | null {
  const s = parseSpacePath(path)
  if (!s) return null
  const sp = s.space
  const space: DisplaySpace = sp.kind === 'shared'
    ? { kind: 'shared', root: sp.root, id: sp.id, name: spaceName(sp.root) ?? sp.readable }
    : sp.owner === me.normalize('NFC') ? { kind: 'mine', root: sp.root } : { kind: 'person', root: sp.root, owner: sp.owner }
  if (s.inner === '') return { space, folders: [], name: '' }
  const segs = s.inner.split('/')
  const last = segs.pop()!
  return { space, folders: segs, name: last.replace(/\.md$/i, '') }
}
