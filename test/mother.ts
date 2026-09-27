// The object mother of the tests: invented people, credentials and content,
// drawn with faker from the run's seed (seed.ts). Tests speak of roles
// ("the admin", "a member") and of "a note", never of a particular name,
// password or title, so nothing a test passes with depends on the one value
// someone happened to write, and no real person's name or secret is ever in
// the repository. A value whose content *is* the case under test (a parser's
// edge case, «Straße» folding, an RFC vector) stays a literal in its test.
//
//   const m = mother(import.meta.url)
//   const member = m.aUser({ role: 'member' })   // { username, password, role }
//   const path = m.aNotePath(m.aFolder())        // 'ocre/Mesa rústica.md'
//
// Every value satisfies thoth's own rules for its kind (a username matches
// NAME_PATTERN, a password is at least MIN_PASSWORD long, a note path is a
// valid `.md` path, a tag is a tag), and is Spanish-flavoured, so accents
// and «ñ» are everywhere. Usernames and group names are unique in the process
// under thoth's comparison (subjectKey), note and folder names and tags under
// its case folding, and none of them names anything in testdata/vault (the
// tests copy it) nor a literal a test keeps (RESERVED).
//
// Deterministic: each file's values come from its own stream, seeded by the
// run's seed and the file's path (and a lane, see `mother`), so the same seed
// gives the same values whether the file runs alone or with the rest.
import { Faker, base, es } from '@faker-js/faker'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { caseFold } from '../packages/core/src/casefold.ts'
import { testSeed } from './seed.ts'

/** This run's seed (THOTH_TEST_SEED, or chosen now and put in the environment). */
export const SEED = testSeed()

/** thoth's rules the values follow; mother.test.ts checks they are still the server's and core's. */
export const NAME_PATTERN = /^[\p{L}\p{N}._-]{2,64}$/u
export const MIN_PASSWORD = 10
/** How thoth compares user and group names (core's subjectKey). */
export const subjectKey = (s: string) => s.normalize('NFC').toLowerCase()

/**
 * Literals some tests keep because they are the case under test (Unicode
 * folding of usernames, say): the mother never hands out anything that
 * compares equal to them.
 */
export const RESERVED = ['ángela', 'otro', 'nadie', 'x', 'y']

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VAULT = join(ROOT, 'testdata/vault')

// What this process has handed out (or must never hand out).
const taken = {
  /** subjectKey of usernames and group names. */
  names: new Set<string>(),
  /** caseFold of note titles, folder names and key names. */
  notes: new Set<string>(),
  /** caseFold of tags and unique words. */
  words: new Set<string>(),
  /** caseFold of display names, and e-mail addresses. */
  display: new Set<string>(),
  /** Passwords and secrets: never the same twice, so a "wrong" one is wrong. */
  secrets: new Set<string>(),
}

/** Spanish words, lowercase, letters only: faker's Spanish data has no dictionary, so it's gathered from its lists. */
const VAULT_WORDS = vaultWords()

const WORDS: readonly string[] = (() => {
  const lists: unknown[] = [
    es.color?.human, es.commerce?.department, es.commerce?.product_name,
    es.company?.adjective, es.company?.noun, es.company?.descriptor,
    es.location?.city_name, es.location?.street_suffix,
    es.person?.job_area, es.person?.job_type, es.person?.job_descriptor,
  ]
  const flat = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(flat) : v && typeof v === 'object' ? Object.values(v).flatMap(flat) : [])
  const stop = new Set(['del', 'los', 'las', 'con', 'por', 'para', 'una', 'the', 'and'])
  const out = new Set<string>()
  for (const w of lists.flatMap(flat).flatMap((s) => s.split(/[\s/-]+/))) {
    const word = w.normalize('NFC').toLowerCase()
    if (/^\p{Ll}{3,14}$/u.test(word) && !stop.has(word)) out.add(word)
  }
  // No word of the test vault: a search for a generated word finds only what the test wrote.
  for (const word of VAULT_WORDS) out.delete(word)
  return [...out].sort()
})()

const FIRST_NAMES: readonly string[] = [...new Set(Object.values(es.person!.first_name as Record<string, string[]>).flat())].sort()
const LAST_NAMES: readonly string[] = [...new Set(flatStrings(es.person!.last_name))].sort()

function flatStrings(v: unknown): string[] {
  return typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(flatStrings) : v && typeof v === 'object' ? Object.values(v).flatMap(flatStrings) : []
}

/** Every name and word in testdata/vault (folded), read once. */
function vaultWords(): Set<string> {
  const words = new Set<string>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      for (const w of e.name.replace(/\.md$/i, '').split(/[^\p{L}\p{N}]+/u)) if (w) words.add(caseFold(w))
      words.add(caseFold(e.name.replace(/\.md$/i, '')))
      if (e.isDirectory()) walk(p)
      else if (/\.(md|json|canvas)$/i.test(e.name)) {
        for (const w of readFileSync(p, 'utf8').split(/[^\p{L}\p{N}]+/u)) if (w) words.add(caseFold(w.normalize('NFC')))
      }
    }
  }
  walk(VAULT)
  return words
}

for (const w of VAULT_WORDS) {
  taken.notes.add(w)
  taken.words.add(w)
  taken.names.add(subjectKey(w))
}
for (const r of RESERVED) {
  taken.names.add(subjectKey(r))
  taken.notes.add(caseFold(r))
}

/** 32-bit FNV-1a of a string: the scope's part of a stream's seed. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (const ch of new TextEncoder().encode(s)) h = Math.imul(h ^ ch, 0x01000193) >>> 0
  return h
}

export type Role = 'admin' | 'member'
/** A person to create: a username, a password and a role. */
export interface NewUser { username: string; password: string; role: Role }

export interface MotherOptions {
  /**
   * Another stream for the same file, for a process that must not repeat
   * what an earlier one of the same run created on a server that outlives
   * it: Playwright's worker index (a failed test is retried in a new worker).
   * Usernames and group names of a lane other than 0 end in `-w<lane>`, so
   * they never clash with lane 0's.
   */
  lane?: string | number
}

export type Mother = ReturnType<typeof mother>

/**
 * The values of one file: `scope` is its `import.meta.url` (or any fixed
 * text shared by processes that must agree, such as a server and its specs).
 */
export function mother(scope: string | URL, opts: MotherOptions = {}) {
  const where = String(scope).startsWith('file:') ? relative(ROOT, fileURLToPath(scope)) : String(scope)
  const lane = opts.lane === undefined || String(opts.lane) === '0' ? '' : String(opts.lane)
  const faker = new Faker({ locale: [es, base] })
  faker.seed([SEED, hash(where), hash(lane)])
  const pick = <T>(list: readonly T[]): T => faker.helpers.arrayElement(list as T[])
  const int = (min: number, max: number) => faker.number.int({ min, max })
  const chance = (p: number) => faker.number.float({ min: 0, max: 1 }) < p
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const suffix = lane ? `-w${lane}` : ''

  /** Draws until `make` gives a value `ok` accepts (and records it), or gives up loudly. */
  function draw<T>(what: string, make: () => T, ok: (v: T) => boolean): T {
    for (let i = 0; i < 2000; i++) {
      const v = make()
      if (ok(v)) return v
    }
    throw new Error(`mother: no new ${what} after 2000 tries (seed ${SEED}, ${where})`)
  }
  const fresh = (set: Set<string>, key: string) => (set.has(key) ? false : (set.add(key), true))
  /** A name part: letters only, spaces turned into a separator or dropped. */
  const part = (s: string) => s.normalize('NFC').replace(/\s+/g, pick(['', '.', '_'])).replace(/[^\p{L}\p{N}._]/gu, '')

  const m = {
    /** The faker behind it, for anything the mother doesn't offer (same stream, same seed). */
    faker,
    seed: SEED,

    // --- People and credentials -------------------------------------------

    /** A valid username nobody else in this process has (under subjectKey). */
    aUsername(): string {
      return draw('username', () => {
        const first = part(pick(FIRST_NAMES))
        const last = part(pick(LAST_NAMES))
        const name = pick([
          () => first,
          () => `${first}.${last}`,
          () => `${first}_${last}`,
          () => `${first}-${last}`,
          () => `${first}${int(1, 99)}`,
          () => `${first.charAt(0)}${last}`,
        ])()
        return (chance(0.5) ? name.toLowerCase() : name) + suffix
      }, (n) => NAME_PATTERN.test(n) && fresh(taken.names, subjectKey(n)))
    },

    /** Someone to create: a new username, a password, and a role (member by default). */
    aUser(opts: { role?: Role } = {}): NewUser {
      return { username: m.aUsername(), password: m.aPassword(), role: opts.role ?? 'member' }
    },

    /** A password thoth accepts (at least MIN_PASSWORD), never handed out before in this process. */
    aPassword(): string {
      return draw('password', () => {
        const words = [pick(WORDS), pick(WORDS), pick(WORDS)].map((w, i) => (i === int(0, 2) ? capital(w) : w))
        return words.join(pick(['-', '.', '_', '·'])) + int(10, 99)
      }, (p) => p.length >= MIN_PASSWORD && fresh(taken.secrets, p))
    },

    /** A password thoth rejects as too short (1 to MIN_PASSWORD - 1 characters). */
    aWeakPassword(): string {
      return pick(WORDS).repeat(3).slice(0, int(1, MIN_PASSWORD - 1))
    },

    /** A random secret (a key, a token): `length` letters and digits, never handed out before. */
    aSecret(length = 40): string {
      return draw('secret', () => faker.string.alphanumeric(length), (s) => fresh(taken.secrets, s))
    },

    /** A valid group name, unique among the names of this process (users' too). */
    aGroupName(): string {
      return draw('group name', () => {
        const name = pick([() => pick(WORDS), () => `${pick(WORDS)}-${pick(WORDS)}`, () => `${pick(WORDS)}${int(2, 99)}`])()
        return (chance(0.3) ? capital(name) : name) + suffix
      }, (n) => NAME_PATTERN.test(n) && fresh(taken.names, subjectKey(n)))
    },

    /** A person's full name, as shown (not a username), unique in this process. */
    aDisplayName(): string {
      return draw('display name', () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, (n) => fresh(taken.display, caseFold(n)))
    },

    /** An e-mail address at example.com (a commit's author, say), unique in this process. */
    anEmail(): string {
      return draw('e-mail', () => faker.internet.email({ provider: 'example.com' }).toLowerCase(), (e) => fresh(taken.display, e))
    },

    /** A name for an agent key or an OAuth client: a few words, unique in this process. */
    aKeyName(): string {
      return draw('key name', () => `${capital(pick(WORDS))} ${pick(WORDS)}`, (n) => fresh(taken.notes, caseFold(n)))
    },

    // --- Notes -----------------------------------------------------------------

    /** A Spanish word (lowercase letters); not unique. */
    aWord(): string {
      return pick(WORDS)
    },

    /**
     * A word no other value of this process contains (two words run
     * together, never a word of any sentence): a search for it finds only
     * where the test put it.
     */
    aUniqueWord(): string {
      return draw('unique word', () => `${pick(WORDS)}${pick(WORDS)}`, (w) => w.length <= 28 && fresh(taken.words, caseFold(w)))
    },

    /** A tag's name (no `#`): letters, unique in this process under case folding. */
    aTag(): string {
      return draw('tag', () => pick(WORDS), (t) => fresh(taken.words, caseFold(t)))
    },

    /** A note's title (its file name without `.md`): 1 to 4 words, unique in this process under case folding. */
    aTitle(): string {
      return draw('title', () => capital(Array.from({ length: int(1, 4) }, () => pick(WORDS)).join(' ')), (t) => fresh(taken.notes, caseFold(t)))
    },

    /** A folder's name (one segment): 1 or 2 words, unique like titles. */
    aFolder(): string {
      return draw('folder', () => {
        const name = Array.from({ length: int(1, 2) }, () => pick(WORDS)).join(pick([' ', '-', '_']))
        return chance(0.3) ? capital(name) : name
      }, (f) => fresh(taken.notes, caseFold(f)))
    },

    /** A folder path of `depth` new segments (1 by default). */
    aFolderPath(depth = 1): string {
      return Array.from({ length: depth }, () => m.aFolder()).join('/')
    },

    /** A new note's path: a unique title with `.md`, in `folder` (the root by default). */
    aNotePath(folder = ''): string {
      return `${folder ? `${folder}/` : ''}${m.aTitle()}.md`
    },

    /** A heading's text (not unique). */
    aHeading(): string {
      return capital(Array.from({ length: int(1, 4) }, () => pick(WORDS)).join(' '))
    },

    /** A sentence of `words` words (4 to 10), capitalised, ending in a full stop. */
    aSentence(words = int(4, 10)): string {
      return capital(Array.from({ length: words }, () => pick(WORDS)).join(' ')) + '.'
    },

    /** A paragraph: 2 to 4 sentences. */
    aParagraph(): string {
      return Array.from({ length: int(2, 4) }, () => m.aSentence()).join(' ')
    },

    /** A comment's text. */
    aComment(): string {
      return m.aSentence(int(3, 12))
    },

    // --- Anything else --------------------------------------------------------

    /** An IANA time zone this Node knows (any valid one). */
    aTimeZone(): string {
      return pick(Intl.supportedValuesOf('timeZone'))
    },

    /** An integer from min to max, both included. */
    anInt: int,
    /** One of the list. */
    pick,
    /** true with probability p. */
    chance,
    /** The list in a random order (a copy). */
    shuffle<T>(list: readonly T[]): T[] {
      return faker.helpers.shuffle([...list])
    },
  }
  return m
}
