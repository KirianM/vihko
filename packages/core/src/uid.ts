// Note identifiers: ULID (48 bits of time in ms + 80 random bits, in
// Crockford base32). Sortable by creation time, no coordination needed.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newUid(now = Date.now(), random: Uint8Array = crypto.getRandomValues(new Uint8Array(10))): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time
    t = Math.floor(t / 32)
  }
  let bits = 0
  let acc = 0
  let rand = ''
  for (const byte of random) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      rand += B32[(acc >> bits) & 31]
    }
    acc &= (1 << bits) - 1
  }
  return time + rand
}
