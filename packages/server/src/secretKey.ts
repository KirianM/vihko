// VIHKO_SECRET_KEY: an optional key of the server's
// administrator, kept outside state.db, that encrypts the TOTP secrets in it.
// A copy of state.db (a backup) is then not enough to compute anyone's codes.
//
// - The key is given in the environment (VIHKO_SECRET_KEY) or, for a Docker
//   secret, in a file (VIHKO_SECRET_KEY_FILE). It's never written to disk or
//   to the logs, and it's taken out of the process's environment once read
//   (nothing vihko runs inherits it).
// - AES-256-GCM, with a key derived from it by HKDF-SHA-256 and a random
//   nonce for each secret; the user's id is the additional data, so a secret
//   copied to another user's row doesn't open.
// - Versioned: `v1:<key id>:<nonce>:<ciphertext and tag>` (base64url). A
//   secret kept before (base32, which has no `:`) is plaintext, and both
//   coexist: vihko encrypts the plaintext ones when it starts with a key.
// - The key id is a short fingerprint of the derived key: it tells a secret
//   encrypted with another key apart from a broken one, and says nothing of
//   the key.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The shortest key accepted, in characters (`openssl rand -base64 32` gives 44). */
export const MIN_SECRET_KEY = 32

const VERSION = 'v1'
const INFO = 'vihko totp secrets v1'
const SALT = 'vihko'
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class SecretKeyError extends Error {}

/** The key in force, derived: seals and opens the secrets kept in state.db. */
export class SecretBox {
  /** A short fingerprint of the key (8 hex digits), stored with each secret it encrypts. */
  readonly id: string
  private readonly key: Buffer

  constructor(material: string) {
    if (material.length < MIN_SECRET_KEY) throw new SecretKeyError(`VIHKO_SECRET_KEY must be at least ${MIN_SECRET_KEY} characters long (for example, openssl rand -base64 32)`)
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(material, 'utf8'), SALT, INFO, 32))
    this.id = createHmac('sha256', this.key).update('vihko key id').digest('hex').slice(0, 8)
  }

  /** `plain`, encrypted for `owner` (the user's id). */
  seal(plain: string, owner: string): string {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(owner, 'utf8'))
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
    return `${VERSION}:${this.id}:${nonce.toString('base64url')}:${body.toString('base64url')}`
  }

  /** What `seal` encrypted for `owner`; null if it was another key, another owner, or it's broken. */
  open(sealed: string, owner: string): string | null {
    const p = parseSealed(sealed)
    if (!p || p.keyId !== this.id || p.nonce.length !== NONCE_BYTES || p.body.length < TAG_BYTES) return null
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, p.nonce)
      decipher.setAAD(Buffer.from(owner, 'utf8'))
      decipher.setAuthTag(p.body.subarray(p.body.length - TAG_BYTES))
      return Buffer.concat([decipher.update(p.body.subarray(0, p.body.length - TAG_BYTES)), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }
}

/** Whether a stored secret is encrypted (any version); otherwise, it's plaintext. */
export function isSealed(stored: string): boolean {
  return stored.includes(':')
}

function parseSealed(s: string): { keyId: string; nonce: Buffer; body: Buffer } | null {
  const parts = s.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) return null
  return { keyId: parts[1]!, nonce: Buffer.from(parts[2]!, 'base64url'), body: Buffer.from(parts[3]!, 'base64url') }
}

/**
 * The key from the environment, if any: VIHKO_SECRET_KEY, or the file
 * VIHKO_SECRET_KEY_FILE names (a Docker secret; one trailing newline is
 * ignored). Both at once, an unreadable file or a short key stop the start:
 * the administrator asked for encryption, and nothing is stored in the clear
 * by mistake. Read from `process.env`, both are taken out of it afterwards.
 */
export function secretBoxFrom(env: NodeJS.ProcessEnv = process.env): SecretBox | null {
  const direct = env.VIHKO_SECRET_KEY
  const file = env.VIHKO_SECRET_KEY_FILE
  if (env === process.env) {
    delete process.env.VIHKO_SECRET_KEY
    delete process.env.VIHKO_SECRET_KEY_FILE
  }
  if (direct && file) throw new SecretKeyError('set VIHKO_SECRET_KEY or VIHKO_SECRET_KEY_FILE, not both')
  let material = direct || null
  if (file) {
    try {
      material = readFileSync(file, 'utf8').replace(/\r?\n$/, '')
    } catch (err) {
      throw new SecretKeyError(`VIHKO_SECRET_KEY_FILE can't be read (${(err as NodeJS.ErrnoException).code ?? 'error'}): ${file}`)
    }
  }
  return material ? new SecretBox(material) : null
}
