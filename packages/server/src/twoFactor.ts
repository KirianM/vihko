// The second factor (D-036): TOTP (RFC 6238: HMAC-SHA-1, 6 digits, steps of
// 30 s, one step either side accepted) with node:crypto, and 10 single-use
// recovery codes.
//
// - A code works once: each user's last accepted step is kept, and a code of
//   that step or an earlier one is refused (RFC 6238 §5.2), even within its
//   window. A code is the next step's at most, so nothing waits long.
// - Setting it up: a new secret is kept in memory, and becomes theirs only
//   once a code from it has been verified (Trilium's wizard): an app that
//   was never scanned can't lock anyone out. Doing it again replaces the
//   authenticator (the old one works until the new one is verified).
// - Recovery codes are kept only as their sha256 (with the user's id), and
//   each one works once. Making new ones ends the old ones.
// - The TOTP secret has to be kept (it computes the codes), in state.db,
//   which is backed up and never served. With THOTH_SECRET_KEY (secretKey.ts)
//   it's kept encrypted, and one encrypted with another key (or with none
//   set) can't be read: that person's TOTP codes fail, their recovery codes
//   still work, and `unreadable` tells the admin (D-040 3.4b).
// - The admin's policy (adminSettings.ts): required, optional (the default)
//   or disabled. Disabled, nobody new sets one up; whoever has one is still
//   asked for it (D-040 3.4a).
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Db } from './db.ts'
import { qrCode, type QrCode } from './qr.ts'
import { isSealed, type SecretBox } from './secretKey.ts'

export const TOTP_PERIOD = 30
export const TOTP_DIGITS = 6
/** Steps either side of now whose codes are accepted too (a clock a little off, a code typed as it changed). */
export const TOTP_WINDOW = 1
export const RECOVERY_CODES = 10
/** How long a secret being set up waits for its first code. */
const SETUP_MS = 15 * 60_000
/** Letters of a recovery code: no 0/o, 1/i/l or u, that can be misread. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789'
const ISSUER = 'thoth'

export type TwoFactorPolicy = 'required' | 'optional' | 'disabled'
export const POLICIES: readonly TwoFactorPolicy[] = ['required', 'optional', 'disabled']

// --- Base32 (RFC 4648), the form authenticator apps take secrets in -----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/** Spaces, dashes, padding and case are ignored. Throws on anything else. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error(`not base32: ${ch}`)
    value = ((value << 5) | i) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// --- HOTP / TOTP ---------------------------------------------------------------

/** RFC 4226: the code for `counter`, `digits` long. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', secret).update(msg).digest()
  const offset = h[h.length - 1]! & 0x0f
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** The TOTP step of a moment (ms since the epoch). */
export function totpStep(ms: number): number {
  return Math.floor(ms / 1000 / TOTP_PERIOD)
}

/** RFC 6238: the code at a moment (ms since the epoch). */
export function totp(secret: Uint8Array, ms: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(ms), digits)
}

/** The step within the window whose code this is (a code from `asTotp`), or null. Every step is compared, in constant time. */
function matchStep(secret: Uint8Array, code: string, now: number): number | null {
  const step = totpStep(now)
  let found: number | null = null
  for (let s = step - TOTP_WINDOW; s <= step + TOTP_WINDOW; s++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(code)) && found === null) found = s
  }
  return found
}

/** A TOTP code as typed: digits, with any spaces taken out; null if it isn't one. */
export function asTotp(code: unknown): string | null {
  if (typeof code !== 'string') return null
  const c = code.replace(/\s/g, '')
  return /^\d{6}$/.test(c) ? c : null
}

/** A recovery code as typed (any case, with or without its dash or spaces); null if it can't be one. */
export function asRecovery(code: unknown): string | null {
  if (typeof code !== 'string') return null
  const c = code.toLowerCase().replace(/[\s-]/g, '')
  return c.length === 10 && [...c].every((ch) => RECOVERY_ALPHABET.includes(ch)) ? c : null
}

// --- The store ------------------------------------------------------------------

export interface TwoFactorStatus {
  /** Whether they set it up (whatever the policy says now). */
  enabled: boolean
  enabledAt: string | null
  /** Recovery codes not used yet. */
  recoveryCodesLeft: number
}

/** What setting it up shows: the secret (grouped by four, to type it), the URI, and its QR code. */
export interface SetupData {
  secret: string
  uri: string
  qr: QrCode | null
}

/** A code checked: `used` is a TOTP code already accepted once (or an earlier one). */
export type CodeResult = { ok: true; recovery: boolean; recoveryCodesLeft: number } | { ok: false; reason: 'invalid' | 'used' }

const recoveryHash = (userId: string, code: string) => createHash('sha256').update(`${userId}\n${code}`).digest('hex')

export class TwoFactor {
  private db: Db
  private now: () => Date
  /** THOTH_SECRET_KEY, derived: secrets are stored encrypted with it (null: plaintext, as before). */
  private box: SecretBox | null
  /** Secrets being set up, by user: not theirs until a code from them is verified. */
  private pending = new Map<string, { secret: Buffer; until: number }>()

  constructor(state: Db, opts: { now?: () => Date; box?: SecretBox | null } = {}) {
    this.db = state
    this.now = opts.now ?? (() => new Date())
    this.box = opts.box ?? null
  }

  /** Whether secrets are stored encrypted (THOTH_SECRET_KEY is set). */
  get encrypted(): boolean {
    return this.box !== null
  }

  /** A secret (base32) as it's stored: encrypted with the key in force, if there is one. */
  private stored(userId: string, b32: string): string {
    return this.box ? this.box.seal(b32, userId) : b32
  }

  /** A stored secret as bytes; null if it can't be read (encrypted, with another key or none). */
  private secretOf(userId: string, stored: string): Buffer | null {
    if (!isSealed(stored)) return base32Decode(stored)
    const b32 = this.box?.open(stored, userId)
    return b32 ? base32Decode(b32) : null
  }

  /**
   * With a key: the secrets still in plaintext are encrypted with it (at
   * startup, when it was just set). How many. Without one, nothing.
   */
  sealPlaintext(): number {
    const box = this.box
    if (!box) return 0
    return this.db.transaction(() => {
      const rows = this.db.prepare('select user_id, secret from two_factor').all() as { user_id: string; secret: string }[]
      const put = this.db.prepare('update two_factor set secret = ? where user_id = ? and secret = ?')
      let n = 0
      for (const r of rows) if (!isSealed(r.secret)) n += put.run(box.seal(r.secret, r.user_id), r.user_id, r.secret).changes
      return n
    })()
  }

  /**
   * The users whose secret can't be read now: encrypted with another key, or
   * with none set. Their TOTP codes fail (recovery codes still work) until
   * the right key is back or the admin takes theirs away.
   */
  unreadable(): string[] {
    const rows = this.db.prepare('select user_id, secret from two_factor').all() as { user_id: string; secret: string }[]
    return rows.filter((r) => this.secretOf(r.user_id, r.secret) === null).map((r) => r.user_id)
  }

  status(userId: string): TwoFactorStatus {
    const r = this.db.prepare('select enabled_at from two_factor where user_id = ?').get(userId) as { enabled_at: string } | undefined
    const left = (this.db.prepare('select count(*) n from recovery_codes where user_id = ? and used_at is null').get(userId) as { n: number }).n
    return { enabled: !!r, enabledAt: r?.enabled_at ?? null, recoveryCodesLeft: r ? left : 0 }
  }

  /** Whether they set it up (the policy aside). */
  enabled(userId: string): boolean {
    return !!this.db.prepare('select 1 from two_factor where user_id = ?').get(userId)
  }

  /**
   * A new secret for `account` (their name; `host`: where thoth is reached,
   * so that two installations tell apart in the app). It isn't theirs until
   * `finishSetup` verifies a code from it; a new one replaces it.
   */
  beginSetup(userId: string, account: string, host?: string | null): SetupData {
    const secret = randomBytes(20) // 160 bits (RFC 4226 §4)
    const now = this.now().getTime()
    for (const [k, v] of this.pending) if (v.until <= now) this.pending.delete(k)
    this.pending.set(userId, { secret, until: now + SETUP_MS })
    const b32 = base32Encode(secret)
    const label = `${ISSUER}:${account}${host ? `@${host}` : ''}`
    const uri = `otpauth://totp/${encodeURIComponent(label).replace(/%3A/, ':')}?secret=${b32}&issuer=${ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`
    return { secret: b32.replace(/(.{4})(?=.)/g, '$1 '), uri, qr: qrCode(uri) }
  }

  /**
   * Verifies a code from the secret being set up and, if it's right, makes
   * it theirs (replacing an earlier one) with new recovery codes, which come
   * back this once. Null if the code is wrong, or there is nothing being set up.
   */
  finishSetup(userId: string, code: unknown): string[] | null {
    const p = this.pending.get(userId)
    const c = asTotp(code)
    const now = this.now()
    if (!p || p.until <= now.getTime() || !c) return null
    const step = matchStep(p.secret, c, now.getTime())
    if (step === null) return null
    this.pending.delete(userId)
    return this.db.transaction(() => {
      this.db.prepare(`insert into two_factor (user_id, secret, enabled_at, last_step) values (?, ?, ?, ?)
        on conflict(user_id) do update set secret = excluded.secret, enabled_at = excluded.enabled_at, last_step = excluded.last_step`)
        .run(userId, this.stored(userId, base32Encode(p.secret)), now.toISOString(), step)
      return this.newRecoveryCodes(userId)
    })()
  }

  /**
   * Checks a code: a TOTP code, or (with `recovery`) a recovery code, which
   * is spent. A TOTP code is accepted once.
   */
  verify(userId: string, code: unknown, opts: { recovery?: boolean } = {}): CodeResult {
    const row = this.db.prepare('select secret, last_step from two_factor where user_id = ?').get(userId) as { secret: string; last_step: number } | undefined
    if (!row) return { ok: false, reason: 'invalid' }
    const t = asTotp(code)
    if (t) {
      // A secret that can't be read (another THOTH_SECRET_KEY) matches no code.
      const secret = this.secretOf(userId, row.secret)
      const step = secret ? matchStep(secret, t, this.now().getTime()) : null
      if (step === null) return { ok: false, reason: 'invalid' }
      // Only a later step than the last one accepted: one request wins if two race with the same code.
      const won = this.db.prepare('update two_factor set last_step = ? where user_id = ? and last_step < ?').run(step, userId, step).changes > 0
      return won ? { ok: true, recovery: false, recoveryCodesLeft: this.status(userId).recoveryCodesLeft } : { ok: false, reason: 'used' }
    }
    const r = opts.recovery ? asRecovery(code) : null
    if (!r) return { ok: false, reason: 'invalid' }
    const spent = this.db.prepare('update recovery_codes set used_at = ? where user_id = ? and code_hash = ? and used_at is null')
      .run(this.now().toISOString(), userId, recoveryHash(userId, r)).changes > 0
    return spent ? { ok: true, recovery: true, recoveryCodesLeft: this.status(userId).recoveryCodesLeft } : { ok: false, reason: 'invalid' }
  }

  /** New recovery codes (the old ones stop working), shown this once. Null if they have no second factor. */
  regenerate(userId: string): string[] | null {
    if (!this.enabled(userId)) return null
    return this.db.transaction(() => this.newRecoveryCodes(userId))()
  }

  /** Takes the second factor away (theirs, or the admin's reset). Whether there was one. */
  disable(userId: string): boolean {
    this.pending.delete(userId)
    return this.db.transaction(() => {
      this.db.prepare('delete from recovery_codes where user_id = ?').run(userId)
      return this.db.prepare('delete from two_factor where user_id = ?').run(userId).changes > 0
    })()
  }

  private newRecoveryCodes(userId: string): string[] {
    const codes = Array.from({ length: RECOVERY_CODES }, () => {
      let c = ''
      for (let i = 0; i < 10; i++) c += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]
      return c
    })
    this.db.prepare('delete from recovery_codes where user_id = ?').run(userId)
    const put = this.db.prepare('insert into recovery_codes (user_id, code_hash) values (?, ?)')
    for (const c of codes) put.run(userId, recoveryHash(userId, c))
    return codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`)
  }
}
