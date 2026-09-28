// Collaboration hub: hot notes as Yjs documents over the file's text. The file
// is still the source of truth; the document is a cache that exists while
// someone has the note open.
//
// Who may open a note, and what they may do in it, is the access filter's
// (access.ts, D-038): connecting needs `read` (a note one can't read doesn't
// exist, as over HTTP); with `read` or `comment` the connection is read-only
// (the server drops every change it sends; with `comment`, a comment comes
// over HTTP as one exact operation the server builds, commenting.ts, and
// reaches the document through the note service like any other write); with
// `edit`, it writes. When someone's access changes while the note
// is open (vihko.yaml, groups, a user disabled), their connection is told
// (`ACCESS_MESSAGE`) and closed at once: they reopen it with what they have
// now, or not at all. Every message the hub sends is classified in
// `HUB_MESSAGES` (hubMessages.ts), for the leak tests.
//
// Presence is signed by the server (D-040 3.3, as Outline does): what a
// connection announces in the awareness is its session's person, with the
// id and name the server knows, whatever the client says (`signPresence`).
import { Hocuspocus, type Connection, type Document } from '@hocuspocus/server'
import diff from 'fast-diff'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { baseHue, contentHash, isPersonHue, newUid, readFrontmatter, setFrontmatterKey } from '@vihko/core'
import { sessionIdOf, type Auth, type User } from './auth.ts'
import { readStable, readText, replaceText } from './fsutil.ts'
import type { Indexer } from './indexer.ts'
import { NoteError, NoteService, type Actor, type Change, type HotDocuments } from './notes.ts'
import type { Via } from './actor.ts'
import type { AccessPolicy } from './access.ts'
import { sameHost } from './http/origin.ts'

export const TEXT = 'md'
/** Map in the document with the hub's metadata: `generation` (see `load`). */
export const META = 'vihko'
export const COLLAB_PATH = '/collab'
/**
 * The largest message an editor may send, in bytes (`ws` allows 100 MiB by
 * default, all held in memory). An update that carries a note's whole text
 * is about the text's size: the same bound as the API's bodies
 * (MAX_API_BODY), far beyond any note written by hand.
 */
export const MAX_WS_MESSAGE = 20 * 1024 * 1024
const HISTORY = 20

interface Base { snapshot: Uint8Array; text: string; hash: string }

interface Hot {
  doc: Y.Doc
  file: string
  logFile: string
  logFd: number
  /** Document state that matches what's on disk. */
  snapshot: Uint8Array
  flushedText: string
  flushedHash: string
  /** Last flushed states: an external editor may save starting from an old one. */
  history: Base[]
  /** uid the note had when loaded, so it isn't lost if it's removed in the editor. */
  uid: string | null
  /** The note was deleted from vihko: it's no longer flushed. */
  discarded: boolean
  /**
   * The file was deleted from outside while the note was open. Nothing is
   * written to disk until someone decides to keep or discard its copy;
   * meanwhile, what was written stays in the recovery log.
   */
  orphaned: boolean
  /** Agents writing to it now, by key: their presence (see `agentWriting`). */
  agents: Map<string, AgentPresence>
  /**
   * Its editors were told it was deleted and it's listed for a decision. Not
   * at once: the file may have been moved, and the indexer needs a moment to
   * see where it went (see `followMove`).
   */
  announced: boolean
  orphanTimer: NodeJS.Timeout | null
}

/**
 * An agent writing to an open note, as its editors see it (m3 §6). While it
 * writes, and `agentPresenceMs` after its last write, the document's
 * awareness holds, under the agent's own Yjs client id:
 *
 *   { agent: { name, onBehalfOf, via } }
 *
 * `name`: its key's name («Claude Code»); `onBehalfOf`: its user's name;
 * `via`: how it came (`mcp`, `api`, `oauth`). Everything it writes meanwhile
 * is made by that same client id, so an editor can tell its text apart
 * (`item.id.client`) and highlight it. The state is published before the
 * text it announces reaches the editors, and removed when it ends (a later
 * write starts a new presence, with a new client id). There is no `user`
 * field: it isn't a person, and it has no cursor.
 */
export interface AgentPresenceState {
  agent: { name: string; onBehalfOf: string; via: Via | null }
}

interface AgentPresence {
  clientID: number
  /** The agent's own awareness, whose updates are applied to the document's. */
  awareness: Awareness
  /** When it ends, `agentPresenceMs` after the last write. */
  timer: NodeJS.Timeout | null
}

/** A Yjs client id nobody in the document has used or announced. */
function freshClientId(doc: Document): number {
  const used = Y.encodeStateVector(doc)
  const known = new Set([...Y.decodeStateVector(used).keys(), ...doc.awareness.getStates().keys(), doc.clientID])
  for (;;) {
    const id = Math.floor(Math.random() * 0xffffffff)
    if (!known.has(id)) return id
  }
}

/** Live message for editors of a note deleted from outside. */
export const ORPHAN_MESSAGE = 'vihko:deleted-externally'
/** After every flush: `etag` is the hash of the text already on the file. The UI uses it to say "saved". */
export const SAVED_MESSAGE = 'vihko:saved'
/**
 * The note was moved or renamed: editors reopen it at `to`. `external`: it
 * was moved outside vihko, and the hub followed it (`followMove`).
 */
export const MOVED_MESSAGE = 'vihko:moved'
/** The note was moved to the trash from vihko: `id` is the entry, to restore it. */
export const TRASHED_MESSAGE = 'vihko:trashed'
/**
 * To an editor whose copy belongs to another generation of the document: it's
 * refused before anything is synced, and the editor opens the note again.
 */
export const STALE_MESSAGE = 'vihko:stale-generation'
/**
 * To an editor whose access to the note changed while it was open (D-038):
 * `access` is what they have now (`none`, `read`, `comment` or `edit`); the
 * connection is closed right after, and they reopen it with that, if any.
 */
export const ACCESS_MESSAGE = 'vihko:access'
/** An orphan's copy was kept (`restore`) or discarded. */
export const ORPHAN_RESOLVED_MESSAGE = 'vihko:orphan-resolved'
/**
 * To the editors of a session that just ended (the user was disabled or
 * deleted, the admin closed their sessions, another session changed the
 * password): the connection closes next, and the UI goes to sign in.
 */
export const SESSION_ENDED_MESSAGE = 'vihko:session-ended'
/** The WebSocket close code that goes with it. */
export const SESSION_ENDED_CODE = 4401

/**
 * Every message of the collaboration protocol, and who it reaches (m4 §2):
 * a new one without its line here fails the leak tests.
 * - `inbound`, by hocuspocus message type: what a connection (someone who
 *   could read the note when they opened it) may send. `edit`: applied only
 *   for a connection that may write, dropped for a read-only one; `read`:
 *   anyone connected; `ignored`: nothing is done with it.
 * - `outbound`, by vihko's own stateless messages: whom it goes to and what
 *   it carries.
 */
export const HUB_MESSAGES = {
  inbound: {
    Unknown: 'ignored',
    Sync: 'edit', // step 1 only reads; step 2 and updates write
    SyncReply: 'edit',
    Awareness: 'read', // presence and cursors, not the note
    QueryAwareness: 'read',
    Auth: 'read',
    Stateless: 'ignored', // no onStateless hook
    BroadcastStateless: 'ignored', // refused from a client by hocuspocus
    CLOSE: 'read',
    SyncStatus: 'read',
    Ping: 'read',
    Pong: 'read',
  },
  outbound: {
    [SAVED_MESSAGE]: 'the note\'s editors: its ETag',
    [ORPHAN_MESSAGE]: 'the note\'s editors: its own path',
    [ORPHAN_RESOLVED_MESSAGE]: 'the note\'s editors: its own path',
    [MOVED_MESSAGE]: 'the note\'s editors: where it went, only to those who can read it there (null otherwise)',
    [TRASHED_MESSAGE]: 'the note\'s editors: the trash entry and who deleted it',
    [STALE_MESSAGE]: 'one editor, before anything is synced: its own path',
    [ACCESS_MESSAGE]: 'one editor whose access changed: its own path and level',
    [SESSION_ENDED_MESSAGE]: 'the editors of a session that ended: nothing but the type',
  },
} as const

export interface HubOptions {
  notesDir: string
  stateDir: string
  indexer: Indexer
  auth: Auth
  debounceMs?: number
  /** How often hot notes' files are checked. */
  checkMs?: number
  uidKey?: string
  /**
   * How long the file of an open note can be missing before its editors are
   * told it was deleted (6 s): longer than the indexer's window to pair a
   * disappearance with an appearance as a move made outside vihko, which the
   * note follows instead.
   */
  orphanGraceMs?: number
  log?: (msg: string) => void
  /** The history: who types, what the hub writes and what changed outside (history/recorder.ts). */
  history?: HubHistory
  /** An agent's name as its editors see it: its key's name («Claude Code»); null if unknown. */
  agentName?: (keyId: string) => string | null
  /** How long an agent's presence stays after its last write to an open note (5 s). */
  agentPresenceMs?: number
  /**
   * Who may open a note and write in it (access.ts). Without it, anyone with
   * a session opens and writes any note: only the hub's own tests do that.
   */
  policy?: AccessPolicy
  /** How often every open connection's access is checked again, besides each change vihko makes (5 s). */
  accessCheckMs?: number
}

/**
 * What the hub tells the history. Each flush is reported right before the
 * file is written, and a direct write inside its transaction: nothing can see
 * the new text on disk before the history expects it.
 */
export interface HubHistory {
  /**
   * Someone typed in the note since its last flush. `before`: the text right
   * before their change, given when `startsVersion` said it might close the
   * open version (D-034 3.4).
   */
  typing(path: string, actor: Actor, before?: string): void
  /** Whether this person starting to type now would close the version open on the note (someone else's). */
  startsVersion?(path: string, actor: Actor): boolean
  /** What people typed is about to be written. */
  flushing(path: string, text: string): void
  /** A direct write (agent, API, system) to the open note: `typed` is the document right before it. */
  write(path: string, w: { typed: string; after: string; actor: Actor }): void
  /** An external change was integrated: `text` is what's on disk. */
  external(path: string, text: string): void
}

/**
 * `generation`: the one the editor's copy belongs to (null: an empty copy, it
 * claims none). `level`: what the person had in the note when they connected.
 * `session`: its session's public id (auth.ts `sessionIdOf`).
 */
type Ctx = { user?: User; session?: string; system?: Actor; generation?: string | null; level?: string }

// --- Utilities ---------------------------------------------------------------

function applyTextDiff(ytext: Y.Text, from: string, to: string) {
  let pos = 0
  for (const [op, chunk] of diff(from, to)) {
    if (op === diff.EQUAL) pos += chunk.length
    else if (op === diff.DELETE) ytext.delete(pos, chunk.length)
    else { ytext.insert(pos, chunk); pos += chunk.length }
  }
}

export function generationOf(doc: Y.Doc): string | null {
  const g = doc.getMap(META).get('generation')
  return typeof g === 'string' ? g : null
}

function diffCost(a: string, b: string) {
  let n = 0
  for (const [op, chunk] of diff(a, b)) if (op !== diff.EQUAL) n += chunk.length
  return n
}

// Recovery log: [type:1][len:4 BE][payload]. 'S' = snapshot (hash + flushed state),
// 'U' = update, 'F' = a flush about to replace the file (hash of the text, which is
// the document's state at that point of the log), 'P' = the note's path, in the
// files of a note whose path is too long to be their name (logBase).
function record(type: 'S' | 'U' | 'F' | 'P', payload: Uint8Array): Buffer {
  const head = Buffer.alloc(5)
  head.write(type, 0, 'latin1')
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}
const HASH_LEN = contentHash('').length

/** The longest name a log or state file gets from its note's path; its `.ystate.tmp` still fits in 255 bytes. */
const MAX_LOG_NAME = 240

/**
 * The name (without extension) of a note's recovery log and saved state: its
 * path URL-encoded, or, when that would be too long for a file name (a path of
 * a few dozen letters of many scripts is), `#` and the path's SHA-256. A
 * name that is a hash holds the path in a 'P' record; `#` never starts an
 * encoded path, so the two never meet.
 */
function logBase(path: string): string {
  const encoded = encodeURIComponent(path)
  return Buffer.byteLength(encoded) <= MAX_LOG_NAME ? encoded : `#${createHash('sha256').update(path).digest('hex')}`
}

/** The records that name the note in its files: its path, when the name is a hash. */
const pathRecords = (path: string): Buffer[] => (logBase(path).startsWith('#') ? [record('P', Buffer.from(path, 'utf8'))] : [])

/** The note a log or state file (`name` in `dir`, with `ext`) is for; null if it isn't one of the hub's. */
function logNote(dir: string, name: string, ext: string): string | null {
  const base = name.slice(0, -ext.length)
  if (!base.startsWith('#')) {
    try { return decodeURIComponent(base) } catch { return null }
  }
  let buf: Buffer
  try { buf = readFileSync(join(dir, name)) } catch { return null }
  for (let off = 0; off + 5 <= buf.length;) {
    const len = buf.readUInt32BE(off + 1)
    if (off + 5 + len > buf.length) break
    if (buf.toString('latin1', off, off + 1) === 'P') {
      const path = buf.toString('utf8', off + 5, off + 5 + len)
      return logBase(path) === base ? path : null
    }
    off += 5 + len
  }
  return null
}

/**
 * Tests only: `VIHKO_TEST_CRASH_AT=<point>` kills the process there, as a
 * `kill -9` landing at that exact moment would.
 */
function crashPoint(point: string) {
  if (process.env.VIHKO_TEST_CRASH_AT === point) process.kill(process.pid, 'SIGKILL')
}

/**
 * Replaces a recovery log with `records` in one step (temporary file, fsync,
 * rename): whenever the process dies, the old log or the new one is whole on
 * disk. Truncating it in place and writing it again lost, on a kill in
 * between, what the hub had already acknowledged. Returns the new log's
 * descriptor, to append to it.
 */
function replaceLog(file: string, records: Buffer[], crashAt: string | null = null): number {
  const tmp = file + '.tmp'
  const { O_WRONLY, O_CREAT, O_TRUNC, O_APPEND } = constants
  const fd = openSync(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND)
  for (const r of records) writeSync(fd, r)
  fsyncSync(fd)
  if (crashAt) crashPoint(crashAt)
  renameSync(tmp, file)
  return fd
}
const snapshotRecord = (hash: string, update: Uint8Array) => record('S', Buffer.concat([Buffer.from(hash, 'latin1'), update]))

interface Log {
  updates: Uint8Array[]
  lastSnapshot: Uint8Array
  lastHash: string
  /** Flushes started after the last snapshot: `at` is how many of `updates` make up the text written. */
  flushes: { hash: string; at: number }[]
}

function readLog(file: string): Log | null {
  if (!existsSync(file)) return null
  const buf = readFileSync(file)
  const updates: Uint8Array[] = []
  const flushes: Log['flushes'] = []
  let lastSnapshot: Uint8Array | null = null
  let lastHash = ''
  let off = 0
  while (off + 5 <= buf.length) {
    const type = buf.toString('latin1', off, off + 1)
    const len = buf.readUInt32BE(off + 1)
    if (off + 5 + len > buf.length) break // record truncated by a crash
    const payload = buf.subarray(off + 5, off + 5 + len)
    if (type === 'S') {
      lastHash = payload.toString('latin1', 0, HASH_LEN)
      lastSnapshot = payload.subarray(HASH_LEN)
      updates.push(lastSnapshot)
    } else if (type === 'F') flushes.push({ hash: payload.toString('latin1'), at: updates.length })
    else if (type !== 'P') updates.push(payload)
    off += 5 + len
  }
  return lastSnapshot ? { updates, lastSnapshot, lastHash, flushes } : null
}

/** The hash of the text a saved state (`.ystate`) holds, from its first record alone; null if it isn't one. */
function savedHash(file: string): string | null {
  const head = Buffer.alloc(5 + HASH_LEN)
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    if (readSync(fd, head, 0, head.length, 0) < head.length) return null
    if (head.toString('latin1', 0, 1) !== 'S' || head.readUInt32BE(1) < HASH_LEN) return null
    return head.toString('latin1', 5)
  } finally {
    closeSync(fd)
  }
}

/** The states the log's flushes wrote to the file, oldest first. */
function flushedStates(log: Log): Base[] {
  const out: Base[] = []
  const doc = new Y.Doc()
  let applied = 0
  for (const f of log.flushes) {
    for (; applied < f.at; applied++) Y.applyUpdate(doc, log.updates[applied]!)
    const text = doc.getText(TEXT).toString()
    if (contentHash(text) === f.hash) out.push({ snapshot: Y.encodeStateAsUpdate(doc), text, hash: f.hash })
  }
  return out
}

const locks = new Map<string, Promise<unknown>>()
function withLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(name, next.catch(() => {}))
  return next
}

// --- Hub --------------------------------------------------------------------------

export class CollabHub implements HotDocuments {
  readonly hocuspocus: Hocuspocus<Ctx>
  private hot = new Map<string, Hot>()
  private expected = new Map<string, Set<string>>()
  /**
   * Saved states (`.ystate`) this run trusts, by note, with the hash of the
   * text each one holds (D-032.4): the ones it wrote, and the ones that still
   * matched their file after the first scan (`trustSavedStates`). Either way,
   * at that moment the file held nothing that the state lacks and an editor's
   * copy may hold, and from then on vihko is running: a backup of the state
   * volume is only restored with vihko stopped (and an older state no longer
   * matches its file on startup). So whatever the file gets afterwards comes
   * from another tool, and merging it into the state (see `load`) repeats
   * nothing an editor holds. The hash also leaves out a state put back from
   * outside while running.
   */
  private trusted = new Map<string, string>()
  private opts: HubOptions
  private uidKey: string
  private logDir: string
  private checkTimer: NodeJS.Timeout | null = null
  private accessTimer: NodeJS.Timeout | null = null
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE })
  /** Open WebSockets, by user and session (its token, to tell whether it is still in force): ended at once when the session ends (`checkSessions`). */
  private sockets = new Set<{ userId: string; session: string; token: string; close(code: number, reason: string): void }>()
  private log: (m: string) => void

  constructor(opts: HubOptions) {
    this.opts = opts
    this.uidKey = opts.uidKey ?? 'uid'
    this.logDir = join(opts.stateDir, 'collab')
    this.log = opts.log ?? (() => {})
    mkdirSync(this.logDir, { recursive: true })
    const debounce = opts.debounceMs ?? 1000
    this.hocuspocus = new Hocuspocus<Ctx>({
      name: 'vihko',
      quiet: true,
      debounce,
      maxDebounce: debounce * 10,
      onConnect: async ({ documentName, context, connectionConfig }) => {
        NoteService.checkPath(documentName)
        // A note one can't read doesn't exist for them: the same answer as a note that isn't there.
        const level = this.levelOf(context.user, documentName)
        if (level === 'none') throw new NoteError('not_found', `does not exist: ${documentName}`)
        // With `read` or `comment`, every change it sends is dropped (hocuspocus answers it wasn't applied):
        // a comment comes over HTTP (commenting.ts).
        connectionConfig.readOnly = level !== 'edit'
        context.level = level
        // A note deleted or moved from vihko is not reopened: a reconnecting editor cannot resurrect it.
        if (this.hot.get(documentName)?.discarded) throw new NoteError('not_found', `does not exist: ${documentName}`)
        if (!this.hot.has(documentName) && readText(this.file(documentName)) === null) {
          throw new NoteError('not_found', `does not exist: ${documentName}`)
        }
      },
      // The session was checked on the upgrade; the token only says which
      // generation the editor's copy belongs to. It's sent on every reconnection.
      onAuthenticate: async ({ token }) => ({ generation: parseGeneration(token) }),
      // Before anything is synced, in both directions: a copy of another
      // generation would add its whole text a second time.
      beforeSync: async ({ context, document, documentName, connection }) => {
        if (!context.generation) return
        const current = generationOf(document)
        if (context.generation === current) return
        connection.sendStateless(JSON.stringify({ type: STALE_MESSAGE, path: documentName }))
        this.log(`${documentName}: an editor's copy from another generation was refused`)
        // Without `message`, so the hook chain doesn't log it again. Hocuspocus closes the connection.
        throw { code: 4409, reason: STALE_MESSAGE }
      },
      // Presence from a connection: only its own, as the person of its session.
      beforeHandleAwareness: async ({ context, connection, document, states }) => {
        if (connection) this.signPresence(document, connection, context?.user, states)
      },
      onLoadDocument: async ({ documentName, document }) => { await this.load(documentName, document) },
      onStoreDocument: async ({ documentName }) => { await this.flush(documentName) },
      beforeUnloadDocument: async ({ documentName }) => { await this.flush(documentName) },
      afterUnloadDocument: async ({ documentName }) => { await this.unload(documentName) },
    })
  }

  private file(path: string) {
    return join(this.opts.notesDir, NoteService.checkPath(path))
  }

  private logPath(path: string) {
    return join(this.logDir, logBase(path) + '.ylog')
  }

  /**
   * The document as it was when its last editor closed it, with the hash of
   * the text it matched. Only a cache: it's used when the note is reopened so
   * the document keeps its Yjs identity. An editor that lost its connection
   * (network, server restart) and resyncs its old copy then merges into the
   * same document instead of adding a second copy of the whole text, also
   * when the file changed meanwhile if the state is trusted (`trusted`).
   */
  private statePath(path: string) {
    return join(this.logDir, logBase(path) + '.ystate')
  }

  // --- Connections -------------------------------------------------------------

  /** Accepts WebSockets on `/collab` from users with a session and the same origin. */
  attach(server: Server, sessionCookie: string) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Whatever a client sends, it gets an answer: an exception here would
      // be uncaught, and would take the whole server down.
      try {
        this.upgrade(req, socket, head, sessionCookie)
      } catch (e) {
        this.log(`a WebSocket upgrade failed: ${e}`)
        socket.destroy()
      }
    })
    this.checkTimer = setInterval(() => {
      for (const path of this.hot.keys()) this.checkExternal(path).catch((e) => this.log(`check of ${path}: ${e}`))
    }, this.opts.checkMs ?? 1000)
    // Groups and users change outside what vihko writes (piece U): looked at again now and then.
    if (this.opts.policy) this.accessTimer = setInterval(() => this.recheckAccess(), this.opts.accessCheckMs ?? 5000)
  }

  /**
   * One upgrade request. Every header in it is the client's to write, and it
   * hasn't signed in yet: the target is read against a fixed base (never
   * the Host header), and an Origin that isn't a URL isn't this origin.
   */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, sessionCookie: string) {
    // Node's HTTP server stops listening for the socket's errors once it hands
    // it over: a client that resets the connection would be an uncaught error.
    socket.on('error', () => socket.destroy())
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://vihko.invalid')
    } catch {
      return reject(socket, 400)
    }
    // Nothing else here takes a WebSocket: answered, not left open.
    if (url.pathname !== COLLAB_PATH) return reject(socket, 404)
    const origin = req.headers.origin
    if (origin && !sameHost(origin, req.headers.host)) return reject(socket, 403)
    const token = parseCookie(req.headers.cookie ?? '', sessionCookie)
    const user = this.opts.auth.session(token)
    if (!user) return reject(socket, 401)
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const request = new Request(url, { headers: req.headers as Record<string, string> })
      const session = sessionIdOf(token!)
      const conn = this.hocuspocus.handleConnection(ws as never, request, { user, session })
      const live = { userId: user.id, session, token: token!, close: (code: number, reason: string) => ws.close(code, reason) }
      this.sockets.add(live)
      // A frame the protocol doesn't allow: `ws` closes the connection and
      // reports it here. Without a listener, the report would be uncaught.
      ws.on('error', (e: Error) => this.log(`a WebSocket was closed: ${e.message}`))
      ws.on('message', (data: Buffer) => conn.handleMessage(new Uint8Array(data)))
      ws.on('close', (code: number, reason: Buffer) => { this.sockets.delete(live); conn.handleClose({ code, reason: reason.toString() }) })
    })
  }

  // --- Access (D-038) ------------------------------------------------------------

  /** What a person may do in a note now: `none`, `read`, `comment` or `edit` (`manage` writes as `edit`). */
  private levelOf(user: User | undefined, path: string): 'none' | 'read' | 'comment' | 'edit' {
    const policy = this.opts.policy
    if (!policy) return 'edit'
    if (!user) return 'none'
    const access = policy.for({ kind: 'user', user })
    if (!access.canRead(path)) return 'none'
    if (access.canWrite(path)) return 'edit'
    return access.canComment(path) ? 'comment' : 'read'
  }

  /**
   * Checks every open connection against what its person may do now. Whoever
   * lost access, or whose access changed, is told (`ACCESS_MESSAGE`) and
   * closed at once, read-only first so nothing else they send goes in; they
   * reopen it with what they have now. After each permissions change vihko
   * makes, and every few seconds (groups, users).
   */
  recheckAccess() {
    if (!this.opts.policy) return
    const users = new Map<string, User | null>()
    for (const [path, doc] of this.hocuspocus.documents) {
      for (const conn of doc.getConnections()) {
        const ctx = conn.context as Ctx
        if (!ctx.user) continue
        // The person as they are now: disabled or deleted, nothing.
        let user = users.get(ctx.user.id)
        if (user === undefined) users.set(ctx.user.id, (user = this.currentUser(ctx.user)))
        const level = user ? this.levelOf(user, path) : 'none'
        if (level === ctx.level) continue
        conn.readOnly = true
        conn.sendStateless(JSON.stringify({ type: ACCESS_MESSAGE, path, access: level }))
        conn.close({ code: 4403, reason: ACCESS_MESSAGE })
        this.log(`${path}: an editor's access changed (${ctx.level} → ${level}); closed for it to reopen`)
      }
    }
  }

  /**
   * Presence as a connection may announce it (D-040 3.3): only for Yjs
   * clients that are its own (a client id another connection holds, or an
   * agent's presence, is dropped), and only as the person of its session:
   * `user` gets their id and name from the server and a person's hue (the
   * one announced if it is one, outside the agents' band; theirs by default).
   * The cursor's colour, painted in the sender's theme, stays if it is one.
   * `agent` never comes from a connection (the hub publishes agents' own).
   */
  private signPresence(document: Document, connection: Connection<Ctx>, user: User | undefined, states: Map<number, Record<string, unknown>>) {
    const mine = document.getClients(connection)
    const others = new Set<number>()
    for (const c of document.getConnections()) if (c !== connection) for (const id of document.getClients(c)) others.add(id)
    const known = document.awareness.getStates()
    // The session's own (names don't change; someone disabled or deleted is disconnected).
    const name = user?.username ?? null
    for (const [id, state] of [...states]) {
      if (!user || others.has(id) || (known.has(id) && !mine.has(id))) { states.delete(id); continue }
      const { user: claimed, agent: _agent, ...rest } = state
      const said = typeof claimed === 'object' && claimed !== null ? claimed as Record<string, unknown> : null
      if (said === null) { states.set(id, rest); continue }
      const color = typeof said.color === 'string' && /^#[0-9a-f]{6}$/i.test(said.color) ? said.color : null
      states.set(id, {
        ...rest,
        user: { id: user.id, name, hue: isPersonHue(said.hue) ? said.hue : baseHue(user.id), ...(color ? { color, colorLight: color + '33' } : {}) },
      })
    }
  }

  /** The user as state.db has them now; null if they can't sign in any more. */
  private currentUser(user: User): User | null {
    const name = this.opts.auth.username(user.id)
    if (name === null) return null
    const row = this.opts.auth.state.prepare('select role, disabled from users where id = ?').get(user.id) as { role: User['role']; disabled: number } | undefined
    if (!row || row.disabled) return null
    return { ...user, username: name, role: row.role, disabled: false }
  }

  /**
   * Sends one message to each editor of a note, made for its person (`none`
   * leaves them out): what one may see of a move, say, isn't what another may.
   */
  private tellEach(path: string, message: (user: User | undefined) => Record<string, unknown> | null) {
    const doc = this.hocuspocus.documents.get(path)
    if (!doc) return
    for (const conn of doc.getConnections()) {
      const m = message((conn.context as Ctx).user)
      if (m) conn.sendStateless(JSON.stringify(m))
    }
  }

  /**
   * Some of a user's sessions ended (users.ts: disabled, deleted, closed, a
   * new password): the connections of those no longer in force end now,
   * their editors told first so the UI signs out. The others stay.
   */
  checkSessions(userId: string) {
    const ending = [...this.sockets].filter((s) => s.userId === userId && !this.opts.auth.session(s.token))
    if (ending.length === 0) return
    const ended = new Set(ending.map((s) => s.session))
    const payload = JSON.stringify({ type: SESSION_ENDED_MESSAGE })
    for (const doc of this.hocuspocus.documents.values()) {
      for (const c of doc.getConnections()) {
        const ctx = c.context as Ctx
        if (ctx.user?.id === userId && ctx.session && ended.has(ctx.session)) c.sendStateless(payload)
      }
    }
    for (const s of ending) {
      this.sockets.delete(s)
      s.close(SESSION_ENDED_CODE, SESSION_ENDED_MESSAGE)
    }
  }

  async close() {
    if (this.checkTimer) clearInterval(this.checkTimer)
    if (this.accessTimer) clearInterval(this.accessTimer)
    for (const [path, h] of this.hot) this.agentsDone(path, h)
    this.hocuspocus.flushPendingStores()
    for (const path of [...this.hot.keys()]) await this.flush(path)
    this.hocuspocus.closeConnections()
    this.wss.close()
  }

  // --- HotDocuments (note service) -------------------------------------

  /** A discarded note (deleted or moved) no longer counts as open: writes go to the file. */
  has(path: string) {
    const h = this.hot.get(path)
    return !!h && !h.discarded
  }

  /** The text its editors have now; null if it isn't open, or its file is gone (a copy pending a decision isn't the note). */
  text(path: string): string | null {
    const h = this.hot.get(path)
    return h && !h.discarded && !h.orphaned ? h.doc.getText(TEXT).toString() : null
  }

  /**
   * Edit of a hot note: the change is applied as Yjs operations and reaches
   * the open editors. An agent's change is made by its own Yjs client, which
   * its presence names (`AgentPresenceState`), announced first.
   */
  async edit(path: string, fn: (text: string) => Change, opts: { ifMatch?: string; actor: Actor }): Promise<{ etag: string }> {
    const conn = await this.hocuspocus.openDirectConnection(path, { system: opts.actor })
    let result: { etag: string } | NoteError = { etag: '' }
    try {
      await conn.transact((doc) => {
        const ytext = doc.getText(TEXT)
        const cur = ytext.toString()
        const hash = contentHash(cur)
        if (opts.ifMatch !== undefined && opts.ifMatch !== hash) {
          result = new NoteError('precondition_failed', `the note has changed: ${path}`, hash)
          return
        }
        const change = fn(cur)
        const apply = (t: Y.Text) => {
          if (typeof change === 'string') applyTextDiff(t, cur, change)
          else for (const s of change) {
            if (s.remove) t.delete(s.at, s.remove)
            if (s.insert) t.insert(s.at, s.insert)
          }
        }
        const agent = opts.actor.kind === 'agent' && (typeof change === 'string' ? change !== cur : change.length > 0)
          ? this.agentWriting(path, doc, opts.actor)
          : null
        if (agent === null) apply(ytext)
        else {
          // Made on a copy by the agent's client, then merged: the same operations, carrying its id.
          const fork = new Y.Doc()
          Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
          // After loading the state: a copy that receives its own id's operations takes a new one.
          fork.clientID = agent
          const sv = Y.encodeStateVector(fork)
          fork.transact(() => apply(fork.getText(TEXT)))
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(fork, sv))
          fork.destroy()
        }
        const after = ytext.toString()
        if (after !== cur) this.opts.history?.write(path, { typed: cur, after, actor: opts.actor })
        result = { etag: contentHash(after) }
      })
    } finally {
      await conn.disconnect()
    }
    if (result instanceof NoteError) throw result
    return result
  }

  // --- Agents in open notes (m3 §6) ---------------------------------------------

  /**
   * An agent is about to write to an open note: its presence is published (or
   * renewed) and sent to the editors right away, ahead of the text. Returns
   * the Yjs client id its text is made by.
   */
  private agentWriting(path: string, doc: Document, actor: Extract<Actor, { kind: 'agent' }>): number {
    const h = this.hot.get(path)
    let p = h?.agents.get(actor.id)
    if (!p) {
      const presence = new Y.Doc()
      presence.clientID = freshClientId(doc)
      const awareness = new Awareness(presence)
      // Only its state travels: the timer that renews it isn't needed (it ends within seconds).
      clearInterval((awareness as unknown as { _checkInterval: NodeJS.Timeout })._checkInterval)
      p = { clientID: presence.clientID, awareness, timer: null }
      h?.agents.set(actor.id, p)
    }
    const state: AgentPresenceState = {
      agent: { name: this.opts.agentName?.(actor.id) ?? actor.id, onBehalfOf: this.opts.auth.username(actor.onBehalfOf) ?? actor.onBehalfOf, via: actor.via ?? null },
    }
    p.awareness.setLocalState(state)
    applyAwarenessUpdate(doc.awareness, encodeAwarenessUpdate(p.awareness, [p.clientID]), 'agent')
    doc.flush()
    if (p.timer) clearTimeout(p.timer)
    const presence = p
    p.timer = setTimeout(() => this.agentDone(path, actor.id, presence), this.opts.agentPresenceMs ?? 5000)
    p.timer.unref()
    return p.clientID
  }

  /** The agent's presence ends: removed from the document's awareness (its editors see it go). */
  private agentDone(path: string, keyId: string, p: AgentPresence) {
    if (p.timer) clearTimeout(p.timer)
    const h = this.hot.get(path)
    if (h?.agents.get(keyId) === p) h.agents.delete(keyId)
    const doc = this.hocuspocus.documents.get(path)
    if (doc && doc.awareness.getStates().has(p.clientID)) removeAwarenessStates(doc.awareness, [p.clientID], 'agent')
    p.awareness.destroy()
  }

  /** Ends every agent presence in a note (it closes). */
  private agentsDone(path: string, h: Hot) {
    for (const [keyId, p] of [...h.agents]) this.agentDone(path, keyId, p)
  }

  /**
   * The note is deleted from vihko: what is pending is flushed (so the trash gets
   * the latest text), it stops being flushed and its sessions are closed. With
   * `trash`, editors are told the trash entry so they can restore it.
   */
  async discard(path: string, opts: { ifMatch?: string; trash?: { id: string; actor: Actor } } = {}) {
    await withLock(path, async () => {
      const h = this.hot.get(path)
      if (!h) return
      await this.flushNow(path, h)
      if (opts.ifMatch !== undefined && !h.orphaned && opts.ifMatch !== h.flushedHash) {
        throw new NoteError('precondition_failed', `the note has changed: ${path}`, h.flushedHash)
      }
      h.discarded = true
      if (opts.trash) {
        const msg = { type: TRASHED_MESSAGE, path, id: opts.trash.id, by: this.actorName(opts.trash.actor) }
        this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify(msg))
      }
    })
    this.hocuspocus.closeConnections(path)
  }

  /**
   * Moves a hot note. With the document locked, what is pending is flushed and
   * `run` does the move on disk (the file matches the document) and returns the
   * text left at the destination. The note's own changes (rewritten links, uid)
   * are merged into the document, and editors are told to reopen it at the new
   * path. Anything typed during the move is written to the destination: nothing
   * is lost.
   */
  async move<T>(from: string, to: string, run: () => Promise<{ result: T; written: string | null }>): Promise<T> {
    let late: { text: string; base: string } | null = null
    const result = await withLock(from, async () => {
      const h = this.hot.get(from)
      if (!h || h.discarded) return (await run()).result // closed meanwhile: plain move
      await this.flushNow(from, h)
      if (h.orphaned) throw new NoteError('not_found', `does not exist: ${from}`)
      const base = Y.encodeStateAsUpdate(h.doc)
      const text = h.doc.getText(TEXT).toString()
      h.discarded = true
      let r: { result: T; written: string | null }
      try {
        r = await run()
      } catch (err) {
        h.discarded = false
        throw err
      }
      if (r.written !== null && r.written !== text) {
        // Like an external change: from the flushed state, so as not to overwrite what was typed meanwhile.
        const fork = new Y.Doc()
        Y.applyUpdate(fork, base)
        const sv = Y.encodeStateVector(fork)
        fork.transact(() => applyTextDiff(fork.getText(TEXT), text, r.written!))
        Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(fork, sv), 'move')
      }
      this.tellMoved(from, to, false)
      this.hocuspocus.closeConnections(from)
      const final = h.doc.getText(TEXT).toString()
      if (r.written !== null && final !== r.written) late = { text: final, base: r.written }
      this.log(`${from} moved to ${to} while open`)
      return r.result
    })
    if (late) {
      const { text, base } = late as { text: string; base: string }
      this.opts.history?.flushing(to, text)
      const w = await replaceText(this.file(to), text, contentHash(base))
      if (w.replaced) this.opts.indexer.indexPaths([to])
      else this.log(`${to}: could not write what was typed during the move (the file changed)`)
    }
    return result
  }

  // --- Moves made outside vihko (D-031.4) ---------------------------------------

  /**
   * Moves the indexer detected outside vihko. A note open in an editor (or
   * whose copy waits in its recovery log) follows its file instead of being
   * taken as deleted (D-022).
   */
  followMoves(moves: readonly { from: string; to: string }[]) {
    for (const { from, to } of moves) {
      if (!this.hot.has(from) && !existsSync(this.logPath(from))) continue
      this.followMove(from, to).catch((e) => this.log(`${from}: could not follow its move to ${to}: ${e instanceof Error ? e.message : String(e)}`))
    }
  }

  /**
   * The note at `from` was moved outside vihko to `to`: as for a move from
   * vihko, the document is closed and its editors reopen it at `to`. What was
   * typed and hadn't reached the file (while it was missing, nothing was
   * written) is written at `to`, merged with whatever the other tool changed on
   * the way; the old path is never written again. Only when the hub can tell
   * it's the same note: `to` has the note's `uid` or, without one, exactly the
   * text last written. Otherwise the note stays as deleted outside vihko, with
   * its copy (D-022). Resolves to whether it followed.
   */
  async followMove(from: string, to: string): Promise<boolean> {
    // Only in the recovery log (its editors left, or the server restarted): loaded to follow it.
    const conn = this.hot.has(from) ? null : await this.hocuspocus.openDirectConnection(from, { system: { kind: 'system', reason: { code: 'follow_external_move' } } })
    try {
      return await withLock(from, async () => {
        const h = this.hot.get(from)
        if (!h || h.discarded) return false
        if ((await readStable(h.file)) !== null) return false // still there (or back): not moved
        const target = this.file(to)
        const found = await readStable(target)
        if (found === null || !this.sameNote(h, found)) {
          this.log(`${from}: ${to} doesn't look like the same note; it stays as deleted outside vihko`)
          return false
        }
        h.orphaned = true // written nowhere until it's decided where
        // The other tool may have changed it on the way (it had the uid): like an external change.
        if (contentHash(found) !== h.flushedHash) this.mergeExternal(from, h, found, contentHash(found))
        let disk: string = found
        /** Writes the document at `to` until the file holds it, merging what others write there meanwhile. */
        const writeAt = async () => {
          for (let attempt = 0; ; attempt++) {
            this.ensureUid(h)
            const text = h.doc.getText(TEXT).toString()
            if (text === disk) return
            this.opts.history?.flushing(to, text)
            const r = await replaceText(target, text, contentHash(disk))
            if (r.replaced) {
              this.opts.indexer.indexPaths([to])
              disk = text
              if (r.rescued === null) return
              // Someone wrote in place during the rename: merged, and written again.
              this.mergeExternal(from, h, r.rescued, contentHash(r.rescued), false)
              continue
            }
            const now: string | null = r.current === null ? null : await readStable(target, disk)
            if (now === null || attempt >= 5) throw new Error(now === null ? `${to} disappeared` : `too many races in a row on ${to}`)
            this.mergeExternal(from, h, now, contentHash(now))
            disk = now
          }
        }
        // First with its editors still there: when they reopen it at `to`, what they typed is in the file.
        try {
          await writeAt()
        } catch (err) {
          this.announceOrphan(from, h) // it can't be written there: the copy is kept (D-022)
          throw err
        }
        h.discarded = true
        this.tellMoved(from, to, true)
        this.hocuspocus.closeConnections(from)
        // Closed: nothing else can arrive. What came in between is written
        // before the lock is released, so the log (which unloading removes)
        // outlives the text it holds.
        try {
          await writeAt()
        } catch (err) {
          h.discarded = false
          this.announceOrphan(from, h)
          throw err
        }
        this.log(`${from} was moved outside vihko to ${to} while open: the note follows it`)
        return true
      })
    } finally {
      await conn?.disconnect()
    }
  }

  /**
   * Tells a note's editors it moved: where to, to those who can read it
   * there; to the rest, only that it's gone from where they had it (`to`
   * null): a move into a folder they can't see names nothing of it.
   */
  private tellMoved(from: string, to: string, external: boolean) {
    this.tellEach(from, (user) => ({ type: MOVED_MESSAGE, from, to: this.levelOf(user, to) === 'none' ? null : to, ...(external ? { external: true } : {}) }))
  }

  /** Whether `text` is the note `h` holds: the same `uid` or, without one, the text last written. */
  private sameNote(h: Hot, text: string): boolean {
    const uid = this.uidIn(text)
    if (uid !== null) return uid === (this.uidIn(h.flushedText) ?? h.uid)
    return contentHash(text) === h.flushedHash
  }

  // --- Lifecycle ------------------------------------------------------------

  private load(path: string, doc: Y.Doc) {
    return withLock(path, async () => {
      const file = this.file(path)
      const logFile = this.logPath(path)
      const recovered = readLog(logFile)
      const diskOrNull = await readStable(file)
      const disk = diskOrNull ?? ''
      const diskHash = contentHash(disk)
      // Without pending edits, the last session's document (if the file still exists);
      // what changed on disk since then is merged into it below, like an external change.
      const previous = recovered ?? (diskOrNull === null ? null : readLog(this.statePath(path)))
      let snapshot: Uint8Array
      let flushedText: string
      let flushedHash: string
      let history: Base[] = []
      // Generation: editors whose copy comes from another one are refused (see
      // `beforeSync`). A saved document carries its generation on while every
      // copy of it can merge without repeating text:
      // - it continues as it was left: the file is still the text it matched,
      //   or was deleted and the document is kept as its copy (D-022);
      // - or it's a trusted state (`trusted`) and the file changed after it was
      //   saved, with vihko running. The change is merged below as another
      //   tool's, and an editor's unsent typing merges with it (D-032.4). Only
      //   while the file is still the same note (the same `uid`, or none in
      //   either): another note put at that path isn't what those copies hold.
      // Otherwise the diff from the saved text to the file may add again text
      // that an editor's copy already holds in its own operations (the state is
      // older than the file: restored from a backup), and merging that copy
      // would repeat it. A file changed with vihko stopped can't be told apart
      // from that. A state saved before generations existed gets one too.
      let newGeneration = true
      const setGeneration = () => doc.transact(() => doc.getMap(META).set('generation', randomUUID()), 'generation')
      if (previous) {
        for (const u of previous.updates) Y.applyUpdate(doc, u, 'recovery')
        const base = new Y.Doc()
        Y.applyUpdate(base, previous.lastSnapshot)
        snapshot = previous.lastSnapshot
        flushedText = base.getText(TEXT).toString()
        flushedHash = previous.lastHash
        // Killed after a flush replaced the file but before the log recorded it:
        // the file holds that flush's state, which is already in the document.
        // Merging it as an external change would insert its new text a second time.
        history = flushedStates(previous)
        const own = history.find((b) => b.hash === diskHash)
        if (own) ({ snapshot, text: flushedText, hash: flushedHash } = own)
        if (recovered) this.log(`recovered ${path} from the log (${recovered.updates.length} records)`)
        const matches = diskOrNull === null || diskHash === flushedHash
        const trusted = !recovered && this.trusted.get(path) === previous.lastHash && this.uidIn(disk) === this.uidIn(flushedText)
        newGeneration = !(matches || trusted) || generationOf(doc) === null // none: saved before generations existed
        if (!matches) {
          this.log(newGeneration
            ? `${path}: the saved document doesn't match the file; new generation`
            : `${path}: the file changed after the note was closed, with vihko running; merged into its saved document`)
        }
        if (newGeneration) setGeneration()
      } else {
        doc.getText(TEXT).insert(0, disk)
        setGeneration()
        snapshot = Y.encodeStateAsUpdate(doc)
        flushedText = disk
        flushedHash = diskHash
      }
      const records = [...pathRecords(path), snapshotRecord(flushedHash, snapshot)]
      if (recovered || (previous && newGeneration)) records.push(record('U', Y.encodeStateAsUpdate(doc)))
      const logFd = replaceLog(logFile, records)
      const h: Hot = {
        doc, file, logFile, logFd, snapshot, flushedText, flushedHash,
        history: [...history.filter((b) => b.hash !== flushedHash), { snapshot, text: flushedText, hash: flushedHash }].slice(-HISTORY),
        uid: this.uidIn(flushedText), discarded: false, orphaned: false, agents: new Map(), announced: false, orphanTimer: null,
      }
      this.hot.set(path, h)
      doc.on('update', (update: Uint8Array) => writeSync(h.logFd, record('U', update)))
      this.watchTyping(path, doc)
      // A missing file isn't "empty": it was deleted (server down, or before
      // reopening). Announced at once: a move made meanwhile was already seen
      // by the scan, and is followed when it's reported (`followMoves`).
      if (diskOrNull === null) this.markOrphan(path, h, true)
      else if (previous && diskHash !== flushedHash) this.mergeExternal(path, h, disk, diskHash)
    })
  }

  /**
   * Who types (D-033): a change from an editor's connection carries its
   * session's user, and the history hears of it once applied. Someone who
   * starts writing where others were (D-034 3.4) closes their version with
   * the text from right before their change: it's read before the change
   * is applied, only for them (`startsVersion`).
   */
  private watchTyping(path: string, doc: Y.Doc) {
    const history = this.opts.history
    if (!history) return
    const userOf = (origin: unknown) => {
      const o = origin as { source?: string; connection?: { context?: Ctx } } | null
      return o?.source === 'connection' ? o.connection?.context?.user : undefined
    }
    let before: { transaction: Y.Transaction; text: string } | null = null
    doc.on('beforeTransaction', (tr: Y.Transaction) => {
      const user = userOf(tr.origin)
      before = user && history.startsVersion?.(path, { kind: 'user', id: user.id }) ? { transaction: tr, text: doc.getText(TEXT).toString() } : null
    })
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      const text = before?.transaction === tr ? before.text : undefined
      before = null
      const user = userOf(tr.origin)
      if (user && tr.changed.size > 0) history.typing(path, { kind: 'user', id: user.id }, text)
    })
  }

  /**
   * Integrates an external change into the live document, from the closest
   * recent flush. `onDisk`: `newText` is what's now on disk (not when it was
   * rescued from a write that our own rename overwrote).
   */
  private mergeExternal(path: string, h: Hot, newText: string, newHash: string, onDisk = true) {
    let base = h.history[h.history.length - 1]!
    let best = diffCost(base.text, newText)
    for (const b of h.history) {
      const c = diffCost(b.text, newText)
      if (c < best) { best = c; base = b }
    }
    const fork = new Y.Doc()
    Y.applyUpdate(fork, base.snapshot)
    const sv = Y.encodeStateVector(fork)
    const ftext = fork.getText(TEXT)
    if (ftext.toString() !== base.text) throw new Error('snapshot and base text do not match')
    fork.transact(() => applyTextDiff(ftext, base.text, newText))
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(fork, sv), 'external')
    this.log(`external change integrated into ${path}${onDisk ? '' : ' (rescued from the rename)'}`)
    if (!onDisk) return
    this.opts.history?.external(path, newText)
    h.snapshot = Y.encodeStateAsUpdate(fork)
    h.flushedText = newText
    h.flushedHash = newHash
    this.remember(path, h)
    writeSync(h.logFd, snapshotRecord(newHash, h.snapshot))
  }

  /** Records the file's new state and tells the open editors it's now on disk. */
  private remember(path: string, h: Hot) {
    h.history.push({ snapshot: h.snapshot, text: h.flushedText, hash: h.flushedHash })
    if (h.history.length > HISTORY) h.history.shift()
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: SAVED_MESSAGE, path, etag: h.flushedHash }))
  }

  /** Checks whether a hot note's file changed from outside (watcher or periodic check). */
  checkExternal(path: string) {
    return withLock(path, async () => {
      const h = this.hot.get(path)
      if (!h || h.discarded || h.orphaned) return
      const now = readText(h.file)
      if (now === null) {
        // Could be an editor mid-save via rename: confirmed before deciding.
        if ((await readStable(h.file)) === null) this.markOrphan(path, h)
        return
      }
      if (contentHash(now) === h.flushedHash) return
      const text = await readStable(h.file, h.flushedText)
      if (text === null) return
      const hash = contentHash(text)
      if (hash === h.flushedHash || this.expected.get(path)?.has(hash)) return
      this.mergeExternal(path, h, text, hash)
    })
  }

  flush(path: string) {
    return withLock(path, async () => {
      const h = this.hot.get(path)
      if (h) await this.flushNow(path, h)
    })
  }

  /** Writes the document to the file. Only with the note's lock held. */
  private async flushNow(path: string, h: Hot) {
    if (h.discarded || h.orphaned) return
    const now = readText(h.file)
    if (now === null && (await readStable(h.file)) === null) {
      this.markOrphan(path, h)
      return
    }
    if (now !== null && contentHash(now) !== h.flushedHash) {
      const disk = await readStable(h.file, h.flushedText)
      if (disk !== null) {
        const dh = contentHash(disk)
        if (dh !== h.flushedHash && !this.expected.get(path)?.has(dh)) this.mergeExternal(path, h, disk, dh)
      }
    }
    for (let attempt = 0; ; attempt++) {
      if (attempt > 5) throw new Error(`too many races in a row on ${path}`)
      this.ensureUid(h)
      // Text and snapshot together, before any await.
      const text = h.doc.getText(TEXT).toString()
      if (text === h.flushedText && readText(h.file) !== null) return
      const snap = Y.encodeStateAsUpdate(h.doc)
      const hash = contentHash(text)
      let set = this.expected.get(path)
      if (!set) this.expected.set(path, (set = new Set()))
      set.add(hash)
      writeSync(h.logFd, record('F', Buffer.from(hash, 'latin1')))
      this.opts.history?.flushing(path, text)
      const r = await replaceText(h.file, text, h.flushedHash)
      if (!r.replaced) {
        const disk = await readStable(h.file, h.flushedText)
        if (disk === null) { this.markOrphan(path, h); return }
        this.log(`race with an external write on ${path} (before the rename)`)
        this.mergeExternal(path, h, disk, contentHash(disk))
        continue
      }
      h.snapshot = snap
      h.flushedText = text
      h.flushedHash = hash
      this.remember(path, h)
      // The log starts again from what the file now holds, followed by what
      // arrived while it was being written.
      const records = [...pathRecords(path), snapshotRecord(hash, snap)]
      if (text !== h.doc.getText(TEXT).toString()) {
        records.push(record('U', Y.encodeStateAsUpdate(h.doc, Y.encodeStateVectorFromUpdate(snap))))
      }
      const old = h.logFd
      h.logFd = replaceLog(h.logFile, records, records.length > 1 ? 'log-rewrite' : null)
      closeSync(old)
      this.opts.indexer.indexPaths([path])
      if (r.rescued === null) return
      this.mergeExternal(path, h, r.rescued, contentHash(r.rescued), false)
    }
  }

  private unload(path: string) {
    return withLock(path, () => {
      const h = this.hot.get(path)
      if (!h) return
      if (h.orphanTimer) clearTimeout(h.orphanTimer)
      this.agentsDone(path, h)
      closeSync(h.logFd)
      const clean = !h.discarded && !h.orphaned && h.doc.getText(TEXT).toString() === h.flushedText
      const state = this.statePath(path)
      if (clean) {
        // Kept before the log goes: at every moment one of the two is on disk.
        // Its first record is the snapshot (savedHash reads it alone), then the path if the name is a hash.
        writeFileSync(state + '.tmp', Buffer.concat([snapshotRecord(h.flushedHash, Y.encodeStateAsUpdate(h.doc)), ...pathRecords(path)]))
        renameSync(state + '.tmp', state)
        this.trusted.set(path, h.flushedHash)
      } else {
        rmSync(state, { force: true })
        this.trusted.delete(path)
      }
      // An undecided orphan keeps its log: it's the copy of what was being written.
      if (h.discarded || clean) rmSync(h.logFile, { force: true })
      this.hot.delete(path)
      this.expected.delete(path)
    })
  }

  /**
   * The file is gone: nothing is written to it any more. Its editors are told
   * after a grace period (or at once, with `now`), unless the indexer reports
   * meanwhile that it moved, and the note follows it (`followMove`).
   */
  private markOrphan(path: string, h: Hot, now = false) {
    if (h.orphaned) return
    h.orphaned = true
    if (now) return this.announceOrphan(path, h)
    this.log(`${path}: the file is gone while the note is open; nothing is written to it (waiting to see whether it moved)`)
    h.orphanTimer = setTimeout(() => {
      h.orphanTimer = null
      withLock(path, () => { if (this.hot.get(path) === h && h.orphaned && !h.discarded) this.announceOrphan(path, h) })
        .catch((e) => this.log(`orphan notice for ${path}: ${e}`))
    }, this.opts.orphanGraceMs ?? 6000)
    h.orphanTimer.unref()
  }

  private announceOrphan(path: string, h: Hot) {
    if (h.announced) return
    h.announced = true
    this.log(`${path} was deleted outside vihko while the note was open: nothing is written until someone decides`)
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: ORPHAN_MESSAGE, path }))
  }

  /** Notes deleted from outside with a copy pending a decision (open, or only in the log). */
  orphans(): string[] {
    const out = new Set<string>()
    for (const [path, h] of this.hot) if (h.orphaned && h.announced && !h.discarded) out.add(path)
    for (const f of readdirSync(this.logDir).filter((x) => x.endsWith('.ylog'))) {
      const path = logNote(this.logDir, f, '.ylog')
      if (path === null) continue
      if (!this.hot.has(path) && readText(this.file(path)) === null) out.add(path)
    }
    return [...out].sort()
  }

  /** Keeps the copy: recreates the file with what was being written. */
  async restoreOrphan(path: string): Promise<{ etag: string }> {
    if (!this.orphans().includes(path)) throw new NoteError('not_found', `no pending copy for ${path}`)
    const conn = await this.hocuspocus.openDirectConnection(path, { system: { kind: 'system', reason: { code: 'keep_copy' } } })
    try {
      return await withLock(path, async () => {
        const h = this.hot.get(path)!
        const text = h.doc.getText(TEXT).toString()
        mkdirSync(dirname(h.file), { recursive: true })
        this.opts.history?.flushing(path, text)
        const r = await replaceText(h.file, text, null)
        if (!r.replaced) throw new NoteError('exists', `another note already exists at ${path}`)
        h.orphaned = false
        h.announced = false
        h.snapshot = Y.encodeStateAsUpdate(h.doc)
        h.flushedText = text
        h.flushedHash = contentHash(text)
        this.remember(path, h)
        this.opts.indexer.indexPaths([path])
        this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: ORPHAN_RESOLVED_MESSAGE, path, action: 'restore' }))
        this.log(`${path}: the open copy is kept`)
        return { etag: h.flushedHash }
      })
    } finally {
      await conn.disconnect()
    }
  }

  /** Discards the copy: the external deletion is accepted as final. */
  async discardOrphan(path: string) {
    if (!this.orphans().includes(path)) throw new NoteError('not_found', `no pending copy for ${path}`)
    this.hocuspocus.documents.get(path)?.broadcastStateless(JSON.stringify({ type: ORPHAN_RESOLVED_MESSAGE, path, action: 'discard' }))
    if (this.hot.has(path)) await this.discard(path)
    else {
      rmSync(this.logPath(path), { force: true })
      rmSync(this.statePath(path), { force: true })
      this.trusted.delete(path)
    }
    this.log(`${path}: copy discarded; the external deletion is accepted as final`)
  }

  /**
   * On startup, once the first scan has brought the index up to date and
   * before any note is loaded: the saved states that still match their file
   * are trusted (see `trusted`). The index has each file's hash, so no note is
   * read. One that doesn't match (the file changed with vihko stopped, or the
   * state was restored from a backup) is loaded as before, with a new
   * generation.
   */
  trustSavedStates() {
    let states = 0
    for (const f of readdirSync(this.logDir)) {
      if (!f.endsWith('.ystate')) continue
      states++
      const path = logNote(this.logDir, f, '.ystate')
      if (path === null) continue // not one of the hub's
      const hash = savedHash(join(this.logDir, f))
      if (hash !== null && hash === this.opts.indexer.hashOf(path)) this.trusted.set(path, hash)
    }
    if (states) this.log(`saved editor states: ${this.trusted.size} of ${states} match their file`)
  }

  /** On startup: every pending log is a note with unflushed edits. */
  async recoverAll() {
    for (const f of readdirSync(this.logDir).filter((x) => x.endsWith('.ylog'))) {
      const path = logNote(this.logDir, f, '.ylog')
      if (path === null) continue
      try {
        const conn = await this.hocuspocus.openDirectConnection(path, { system: { kind: 'system', reason: { code: 'crash_recovery' } } })
        await conn.disconnect()
      } catch (err) {
        this.log(`could not recover ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // --- uid: added on flush if the note doesn't have one --------------------

  private uidIn(text: string): string | null {
    const fm = readFrontmatter(text)
    const v = fm.error ? null : fm.data[this.uidKey]
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null
  }

  private ensureUid(h: Hot) {
    const ytext = h.doc.getText(TEXT)
    const cur = ytext.toString()
    if (cur === h.flushedText || this.uidIn(cur) || readFrontmatter(cur).error) return
    h.uid ??= newUid()
    const next = setFrontmatterKey(cur, this.uidKey, h.uid)
    h.doc.transact(() => applyTextDiff(ytext, cur, next), 'uid')
  }

  /** How editors are told who did something: the user's current name, or the agent's key's name (actors carry ids). */
  private actorName(a: Actor): string {
    if (a.kind === 'user') return this.opts.auth.username(a.id) ?? a.id
    return a.kind === 'agent' ? this.opts.agentName?.(a.id) ?? a.id : 'system'
  }
}


/** The generation in an editor's token (`{"generation": …}`); anything else claims none. */
function parseGeneration(token: string): string | null {
  try {
    const g = (JSON.parse(token) as { generation?: unknown } | null)?.generation
    return typeof g === 'string' && g ? g : null
  } catch {
    return null
  }
}

function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k !== name) continue
    // A value that isn't percent-encoded is no session vihko gave.
    try {
      return decodeURIComponent(v.join('='))
    } catch {
      return undefined
    }
  }
  return undefined
}

const REASONS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' } as const

function reject(socket: Duplex, status: keyof typeof REASONS) {
  socket.write(`HTTP/1.1 ${status} ${REASONS[status]}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
