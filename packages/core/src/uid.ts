// Identificadores de nota: ULID (48 bits de tiempo en ms + 80 aleatorios, en
// base32 de Crockford). Ordenables por fecha de creación y sin coordinación.
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
