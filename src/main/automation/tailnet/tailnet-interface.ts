import { existsSync } from 'fs'
import { networkInterfaces, type NetworkInterfaceInfo } from 'os'

// Which address the tailnet listener is allowed to bind, decided from the
// machine's own interfaces — no CLI, no daemon, no network call.
//
// Tailscale gives every node an address out of the IPv4 carrier-grade-NAT
// range 100.64.0.0/10 and the IPv6 range fd7a:115c:a1e0::/48. Those ranges are
// routable only inside the tailnet, so "is this address in one of them" is the
// whole of the bind policy: an interface holding one IS the tailnet interface.
//
// The check is an ALLOWLIST on purpose. A denylist of `0.0.0.0` and the RFC1918
// LAN ranges would be one forgotten range away from exposing the gateway to a
// coffee-shop network; an allowlist fails closed on anything it has not been
// taught, which for a listener carrying ~60 mutating tools is the only safe
// direction (see the epic's cross-cutting "never bind 0.0.0.0" rule).

/** Tailscale's IPv6 pool. */
const TAILNET_IPV6_PREFIX = 'fd7a:115c:a1e0:'

export type TailnetInterface = {
  address: string
  family: 'IPv4' | 'IPv6'
  /** OS interface name (`utun4`, `tailscale0`), for diagnostics only. */
  interfaceName: string
}

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
 * This machine's tailnet interface, or null when Tailscale is not up.
 *
 * Null is the honest answer for "no tailnet interface exists" and the listener
 * refuses to start on it rather than falling back to any other interface.
 */
export function resolveTailnetInterface(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): TailnetInterface | null {
  let ipv6: TailnetInterface | null = null
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
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
