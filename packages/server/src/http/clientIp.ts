// Who is asking, by address, for the login limits (loginLimit.ts).
//
// The address is the socket's. X-Forwarded-For is only believed when the
// socket is one of the reverse proxies the server's administrator declared
// (VIHKO_TRUSTED_PROXIES): anyone else could write whatever they like in it.
// Then the header is read from the right, skipping the trusted proxies: the
// first address that isn't one is the client's.
import { BlockList, isIP } from 'node:net'

/** When the socket has no address (requests made in-process, in tests). */
export const UNKNOWN_IP = 'unknown'

/**
 * VIHKO_TRUSTED_PROXIES: addresses or CIDR ranges, separated by commas or
 * spaces (`10.0.0.5, 172.16.0.0/12, fd00::/8`). Null when unset.
 */
export function trustedProxiesFrom(raw: string | undefined): BlockList | null {
  const items = (raw ?? '').split(/[\s,]+/).filter(Boolean)
  if (items.length === 0) return null
  const list = new BlockList()
  for (const item of items) {
    const [addr, prefix, extra] = item.split('/')
    const ip = plain(addr ?? '')
    const family = isIP(ip)
    const bits = prefix === undefined ? null : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN
    if (!family || extra !== undefined || (bits !== null && !(bits >= 0 && bits <= (family === 4 ? 32 : 128)))) {
      throw new Error(`VIHKO_TRUSTED_PROXIES: "${item}" is not an IP address or a CIDR range (such as 10.0.0.5 or 172.16.0.0/12)`)
    }
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (bits === null) list.addAddress(ip, type)
    else list.addSubnet(ip, bits, type)
  }
  return list
}

/** An address as compared and counted: IPv4-mapped IPv6 as IPv4, without an IPv6 zone. */
function plain(ip: string): string {
  const s = ip.trim().replace(/%.*$/, '')
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s)
  return mapped ? mapped[1]! : s
}

function trusted(list: BlockList, ip: string): boolean {
  const family = isIP(ip)
  return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/** The client's address: the socket's, or X-Forwarded-For's when the socket is a trusted proxy. */
export function clientIp(socket: string | undefined, forwardedFor: string | undefined, proxies: BlockList | null): string {
  let ip = plain(socket ?? '')
  if (!isIP(ip)) return UNKNOWN_IP
  if (!proxies || !trusted(proxies, ip) || !forwardedFor) return ip
  const hops = forwardedFor.split(',').map(plain)
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!
    // Something that isn't an address: whatever is left of it can't be trusted either.
    if (!isIP(hop)) return ip
    ip = hop
    if (!trusted(proxies, hop)) return hop
  }
  return ip
}

/**
 * The key an address is counted under: IPv4 whole, IPv6 by its /64 (one
 * home or server usually gets a whole /64, and would otherwise have 2^64
 * addresses to try from).
 */
export function ipKey(ip: string): string {
  if (isIP(ip) !== 6) return ip
  const [head = '', tail] = ip.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = tail === undefined ? [] : tail ? tail.split(':') : []
  if (right.some((g) => g.includes('.')) || left.some((g) => g.includes('.'))) return ip.toLowerCase()
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}
