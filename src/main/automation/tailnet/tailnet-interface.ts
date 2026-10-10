import { existsSync } from 'fs'
import { networkInterfaces, type NetworkInterfaceInfo } from 'os'

// Which address the tailnet listener is allowed to bind, decided from the
// machine's own interfaces — no CLI, no daemon, no network call.
//
// Tailscale gives every node an address out of the IPv4 shared address space
// 100.64.0.0/10 and the IPv6 range fd7a:115c:a1e0::/48. The IPv6 range is
// Tailscale's alone; the IPv4 one is not. Cloudflare WARP, other VPNs and
// carrier-grade NAT assign from the same 100.64/10, so an interface holding
// such an address may be any of them. Which interface is Tailscale's is
// therefore decided by the interface, not the IPv4 address: its name on Linux
// and Windows, and on macOS, where every tunnel is a `utunN`, the fd7a address
// it carries beside the IPv4 one.
//
// The bind check is an ALLOWLIST on purpose. A denylist of `0.0.0.0` and the
// RFC1918 LAN ranges would be one forgotten range away from exposing the
// gateway to a coffee-shop network; an allowlist fails closed on anything it
// has not been taught, which for a listener carrying ~60 mutating tools is the
// only safe direction (see the epic's cross-cutting "never bind 0.0.0.0" rule).

/** Tailscale's IPv6 pool. */
const TAILNET_IPV6_PREFIX = 'fd7a:115c:a1e0:'

export type TailnetInterface = {
  address: string
  family: 'IPv4' | 'IPv6'
  /** OS interface name (`utun4`, `tailscale0`), for diagnostics only. */
  interfaceName: string
}

/**
 * Whether an address lies in one of the ranges Tailscale assigns from.
 *
 * A range check only, right for an address Tailscale itself reported (a peer
 * out of `tailscale status`) and as the listener's last-line bind guard. It
 * cannot say whether an address on THIS machine is Tailscale's, because its
 * IPv4 range is shared with other VPNs; {@link resolveTailnetInterface} decides
 * that from the interface.
 */
export function isTailnetAddress(address: string): boolean {
  const value = normalize(address)
  if (!value) return false
  const octets = value.split('.')
  if (octets.length === 4) {
    const [first, second] = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
    return first === 100 && second >= 64 && second <= 127
  }
  return value.startsWith(TAILNET_IPV6_PREFIX)
}

function isLoopbackAddress(address: string): boolean {
  const value = normalize(address)
  return value === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

/**
 * The bind allowlist: a tailnet address, or loopback.
 *
 * Loopback is included so tests (and a developer poking at the listener from
 * the same machine) exercise the real server rather than a stub. It is not a
 * remote-exposure hole: 127.0.0.0/8 does not leave the host.
 */
export function isAllowedTailnetBindAddress(address: string): boolean {
  return isTailnetAddress(address) || isLoopbackAddress(address)
}

/**
 * Tailscale's own interface: `tailscale0` on Linux, "Tailscale" on Windows.
 * macOS names every tunnel `utunN`, so there it is the one that also carries
 * an address in Tailscale's IPv6 range, which no other VPN assigns from.
 */
function isTailscaleInterface(interfaceName: string, entries: readonly NetworkInterfaceInfo[]): boolean {
  return (
    /^tailscale/i.test(interfaceName) ||
    entries.some((entry) => normalize(entry.address).startsWith(TAILNET_IPV6_PREFIX))
  )
}

/**
 * This machine's tailnet interface, or null when Tailscale is not up.
 *
 * Null is the honest answer for "no tailnet interface exists" and the listener
 * refuses to start on it rather than falling back to any other interface. A
 * WARP or other VPN tunnel holding a 100.64/10 address is not a fallback
 * either: binding it would report Tailscale as up while the gateway listened
 * on a network the phone cannot reach, and with both running the pick would
 * otherwise come down to the order the OS lists its interfaces in.
 */
export function resolveTailnetInterface(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): TailnetInterface | null {
  let ipv6: TailnetInterface | null = null
  for (const [interfaceName, entries = []] of Object.entries(interfaces)) {
    if (!isTailscaleInterface(interfaceName, entries)) continue
    for (const entry of entries) {
      // The range check still applies inside Tailscale's interface: the same
      // utun carries a link-local fe80:: address that is no use to a peer.
      if (entry.internal || !isTailnetAddress(entry.address)) continue
      const found: TailnetInterface = {
        // Node reports scoped IPv6 as `addr%iface`; the bare address is what listen() wants.
        address: entry.address.split('%')[0],
        family: entry.family === 'IPv6' ? 'IPv6' : 'IPv4',
        interfaceName,
      }
      // IPv4 is what `tailscale ip -4` prints and what pairing URLs carry, so
      // prefer it; an IPv6-only tailnet still works and is returned second.
      if (found.family === 'IPv4') return found
      ipv6 ??= found
    }
  }
  return ipv6
}

function normalize(address: string): string {
  return address.trim().toLowerCase().split('%')[0]
}

/**
 * Whether this process runs inside a WSL distribution. In WSL's mirrored
 * networking mode Windows' own interfaces, the Tailscale one among them,
 * appear inside the distribution, so a Studio server there would bind the
 * PC's tailnet address beside the Windows desktop's own listener. The phone
 * reaches WSL chats through the Windows desktop instead (phase 7 spec, 4.3).
 */
export function isInsideWsl(
  input: {
    platform?: NodeJS.Platform
    env?: Record<string, string | undefined>
    exists?: (path: string) => boolean
  } = {},
): boolean {
  if ((input.platform ?? process.platform) !== 'linux') return false
  const env = input.env ?? process.env
  if (env.WSL_DISTRO_NAME) return true
  return (input.exists ?? existsSync)('/proc/sys/fs/binfmt_misc/WSLInterop')
}

/** The owner's explicit leave for a tailnet listener inside WSL, which is otherwise refused. */
export const TAILNET_IN_WSL_ENV = 'SPRINTENGINE_TAILNET_IN_WSL'
