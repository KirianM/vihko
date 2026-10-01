// Spaces (D-056): where every note lives. The notes folder holds `vihko.yaml`
// and two folders whose names are fixed by the product (D-056.3):
//
//   notes/
//     vihko.yaml
//     people/<username>/          a person's personal space («My notes»)
//       .vihko/                   reserved for their note settings (D-056.16)
//     spaces/<name>/              a shared space, such as spaces/Home
//
// - A path has one real form, the same for everyone: from the notes root,
//   `people/ana/trips/Rome.md`. Its space is the second-level folder: the
//   space's root.
// - A personal space is named after its owner, whose username is unique and
//   never changes. A shared space's folder is its name as it was written
//   (NFC): the name people see (D-056.33). Shared spaces' names are unique in
//   the installation without regard to case (`nameKey`), and visible to
//   everyone in it (not what the spaces hold, nor who is in them). Renaming a
//   space renames its folder.
// - Anything else (the root itself, `people/`, `spaces/`, other top-level
//   entries, a folder under `people/` that can't be a username, one under
//   `spaces/` whose name can't be a space's) is in no space: nobody sees it
//   in vihko.
// - The shared spaces of 0.1.0-rc.1 and rc.2 were `spaces/<readable>-<id>/`,
//   with their name in vihko.yaml: `legacySpaceFolder` reads those, for the
//   start that renames them to their names (the server's legacySpaces.ts).
//
// No imports but case folding, and nothing of Node: the UI uses it too.
import { caseFold } from './casefold.ts'

/** The folder of the personal spaces. */
export const PEOPLE = 'people'
/** The folder of the shared spaces. */
export const SPACES = 'spaces'
/** Inside a personal space, the folder reserved for that person's note settings (hidden: never indexed or served). */
export const SETTINGS_FOLDER = '.vihko'
/** What starts a personal space's address in the browser: `~ana/…` (D-056.29). */
export const PERSONAL_ADDRESS = '~'

/** The longest a shared space's name is, in characters. */
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

/** A shared space: `spaces/<name>`. */
export interface SharedSpace {
  kind: 'shared'
  /** `spaces/<name>`. */
  root: string
  /** Its folder under `spaces/`, as the disk spells it (NFC). */
  folder: string
  /** Its name: the folder's (D-056.33). */
  name: string
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
 * How user names and shared space names are compared for uniqueness: full
 * case folding (casefold.ts) of the NFC form, as links are. On a
 * case-insensitive volume `Straße` and `STRASSE` would be one folder.
 */
export function nameKey(name: string): string {
  return caseFold(name.normalize('NFC'))
}

/** What's wrong with a new shared space's name (spaceNameProblem). */
export type SpaceNameProblem = 'empty' | 'too_long' | 'control_characters' | 'spaces_around' | 'invalid_characters' | 'invalid_name'

/**
 * What's wrong with a name for a new shared space (or one renamed), or null.
 * The name is its folder (D-056.33), so besides `empty`, `too_long` (over
 * SPACE_NAME_MAX characters), `control_characters` and `spaces_around` (a
 * space at the start or the end):
 * - `invalid_characters`: `/` or `\`, which no folder's name can hold;
 * - `invalid_name`: a name no space's folder can have (isSpaceFolderName):
 *   starting with `.` (hidden) or `~` (a person's space in an address),
 *   ending with `.`, `~` or `.md` (some systems drop the first, backups end
 *   in the second, a note in the third), or `people` or `spaces` in any case
 *   (its address would read as a path from the notes root).
 * The caller keeps it in NFC; whether another space has it is the server's.
 */
export function spaceNameProblem(name: string): SpaceNameProblem | null {
  if (name.length === 0) return 'empty'
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control_characters'
  if (name.trim() !== name) return 'spaces_around'
  if ([...name].length > SPACE_NAME_MAX) return 'too_long'
  if (/[\\/]/.test(name)) return 'invalid_characters'
  if (!isSpaceFolderName(name)) return 'invalid_name'
  return null
}

/**
 * Whether a folder under `spaces/` is a shared space, by its name (in any
 * normalization): any but a hidden one, one starting with `~` or ending with
 * `.`, `~` or `.md`, `people` or `spaces` in any case, and one with `/`, `\`
 * or control characters. Laxer than spaceNameProblem: a folder made outside
 * vihko may be longer, or have spaces around its name, and is a space still.
 */
export function isSpaceFolderName(folder: string): boolean {
  const f = folder.normalize('NFC')
  if (f === '' || /[\\/\u0000-\u001f\u007f]/.test(f)) return false
  if (f.startsWith('.') || f.startsWith(PERSONAL_ADDRESS) || f.endsWith('.') || f.endsWith('~') || /\.md$/i.test(f)) return false
  const lower = f.toLowerCase()
  return lower !== PEOPLE && lower !== SPACES
}

// --- The folders of 0.1.0-rc.1 and rc.2 ----------------------------------------
// `spaces/<readable>-<id>/`: a readable part made from the space's name when
// it was created, and after the last hyphen an id of six lowercase letters
// and digits; the name people saw was in vihko.yaml (`name`). Read only to
// rename them to their names when vihko starts (D-056.33).

/** The id of a legacy shared space's folder: six lowercase letters and digits. */
const LEGACY_ID = /^[a-z0-9]{6}$/
/** The longest a legacy readable part was made. */
const READABLE_MAX = 40

/** A folder name of 0.1.0-rc.1 or rc.2 (`home-7k2q9x`) as its readable part and id; null if it can't be one. */
export function legacySpaceFolder(folder: string): { readable: string; id: string } | null {
  const f = folder.normalize('NFC')
  const i = f.lastIndexOf('-')
  if (i <= 0) return null
  const readable = f.slice(0, i)
  const id = f.slice(i + 1)
  if (!LEGACY_ID.test(id) || readable.startsWith('.') || readable.trim() !== readable || /[\\/\u0000-\u001f\u007f]/.test(readable)) return null
  return { readable, id }
}

// The combining marks of accents (Latin, Greek, Cyrillic…), removed from the
// readable part; other marks (the vowel signs of Indic scripts) are letters'.
const ACCENTS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g

/**
 * The readable part 0.1.0-rc.1 and rc.2 made from a space's name: lowercase,
 * without accents, anything but letters and digits made a hyphen (one, never
 * at the ends), at most 40 characters; `space` when nothing was left.
 * `Lista de la Compra!` → `lista-de-la-compra`. The UI matches an old
 * address (`casa-7k2q9x/…`) with the space it was renamed to by it.
 */
export function readablePart(name: string): string {
  const base = name.normalize('NFD').replace(ACCENTS, '').normalize('NFC').toLowerCase()
  const dashed = base.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  const cut = [...dashed].slice(0, READABLE_MAX).join('').replace(/-+$/, '')
  return cut === '' ? 'space' : cut
}

// --- Paths ------------------------------------------------------------------------

/** `people/<username>`. */
export function personalRoot(username: string): string {
  return `${PEOPLE}/${username.normalize('NFC')}`
}

/** `spaces/<name>`. */
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
  if (top === SPACES) return isSpaceFolderName(second) ? { kind: 'shared', root: `${SPACES}/${second}`, folder: second, name: second } : null
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

/** The root of the space a path is in (`people/ana`, `spaces/Home`), or null. */
export function spaceRootOf(path: string): string | null {
  return spaceOf(path)?.root ?? null
}

/** Whether a folder is a space's root: `people/<user>` or `spaces/<name>`. */
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
 * A path's address in the browser (`?note=`, D-056.29): the same for
 * everyone who can open it, and without the product's folders, which are
 * nobody's to see. A shared space by its name (`Home/list.md`), a personal
 * one by `~` and its owner (`~ana/trips/Rome.md`). Null for a path in no
 * space (nobody sees those in vihko).
 */
export function addressOf(path: string): string | null {
  const s = parseSpacePath(path)
  if (!s) return null
  const head = s.space.kind === 'shared' ? s.space.folder : `${PERSONAL_ADDRESS}${s.space.owner}`
  return s.inner === '' ? head : `${head}/${s.inner}`
}

/**
 * The real path an address names (addressOf), or null. A path from the
 * notes root (`people/…`, `spaces/…`, the addresses before D-056.29) is
 * taken as it is, with `legacy` set so the caller writes the new address.
 */
export function pathOfAddress(address: string): { path: string; legacy: boolean } | null {
  const a = address.normalize('NFC').replace(/^\/+/, '')
  if (a === '') return null
  const slash = a.indexOf('/')
  const head = slash === -1 ? a : a.slice(0, slash)
  const rest = slash === -1 ? '' : a.slice(slash)
  if (head === PEOPLE || head === SPACES) return parseSpacePath(a) ? { path: a, legacy: true } : null
  const root = head.startsWith(PERSONAL_ADDRESS)
    ? (isValidUsername(head.slice(PERSONAL_ADDRESS.length)) ? personalRoot(head.slice(PERSONAL_ADDRESS.length)) : null)
    : (isSpaceFolderName(head) ? sharedRoot(head) : null)
  return root === null ? null : { path: root + rest, legacy: false }
}

/**
 * Whose a space is, as one person sees it in the UI:
 * - `mine`: their own personal space («My notes»);
 * - `person`: someone else's personal space («Ana»: a folder they share);
 * - `shared`: a shared space, by its name.
 */
export type DisplaySpace =
  | { kind: 'mine'; root: string }
  | { kind: 'person'; root: string; owner: string }
  | { kind: 'shared'; root: string; name: string }

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
 * is «My notes / diary / day», `spaces/Home/recipes/Bread.md` is «Home /
 * recipes / Bread», `people/ana/trips/Rome.md` is «ana / trips / Rome».
 * Null for a path in no space. Labels and separators are the UI's.
 */
export function displayPath(path: string, me: string): DisplayPath | null {
  const s = parseSpacePath(path)
  if (!s) return null
  const sp = s.space
  const space: DisplaySpace = sp.kind === 'shared'
    ? { kind: 'shared', root: sp.root, name: sp.name }
    : sp.owner === me.normalize('NFC') ? { kind: 'mine', root: sp.root } : { kind: 'person', root: sp.root, owner: sp.owner }
  if (s.inner === '') return { space, folders: [], name: '' }
  const segs = s.inner.split('/')
  const last = segs.pop()!
  return { space, folders: segs, name: last.replace(/\.md$/i, '') }
}
