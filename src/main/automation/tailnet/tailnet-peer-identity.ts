import { runTailscale } from './tailscale-cli'

// Who, on the tailnet, is on the other end of a connection.
//
// The answer comes from Tailscale's own local API, reached through the
// `tailscale whois` CLI (see `tailscale-cli.ts` for why the CLI rather than the
// socket). The identity is the same identity either way — the CLI is a thin
// client over that API.
//
// When Tailscale is not installed, or whois fails, the answer is null. The
// audit record then carries the peer's tailnet ADDRESS and no node name, which
// is the honest statement of what we know — never a placeholder that would read
// like a resolved identity.

const DEFAULT_TIMEOUT_MS = 2000
/** whois is stable for the life of a connection; re-asking per tool call would be a spawn per mutation. */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

export type TailnetPeerResolver = {
  /** Tailscale node name for a remote address, or null when it cannot be resolved. */
  resolve(remoteAddress: string): Promise<string | null>
}

export function createTailnetPeerResolver(options: {
  now?: () => number
  timeoutMs?: number
  cacheTtlMs?: number
  /** Injected in tests; production runs `tailscale whois --json <addr>`. */
  runWhois?: (remoteAddress: string) => Promise<string | null>
  log?: (message: string) => void
} = {}): TailnetPeerResolver {
  const now = options.now ?? (() => Date.now())
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const runWhois = options.runWhois ?? ((address: string) => whoisViaCli(address, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const cache = new Map<string, { value: string | null; expiresAt: number }>()

  return {
    async resolve(remoteAddress): Promise<string | null> {
      const address = normalizeAddress(remoteAddress)
      if (!address) return null
      const cached = cache.get(address)
      if (cached && cached.expiresAt > now()) return cached.value
      let value: string | null = null
      try {
        value = await runWhois(address)
      } catch (error) {
        options.log?.(`Tailscale whois failed for ${address}: ${message(error)}`)
      }
      // A failure is cached too, so a machine without the CLI does not spawn a
      // doomed process on every remote call.
      cache.set(address, { value, expiresAt: now() + cacheTtlMs })
      return value
    },
  }
}

/**
 * Node's `remoteAddress` may be an IPv4-mapped IPv6 (`::ffff:100.x.y.z`) or a
 * scoped IPv6 (`fd7a:...%utun4`); whois wants the bare address.
 */
export function normalizeAddress(remoteAddress: string | undefined | null): string {
  if (typeof remoteAddress !== 'string') return ''
  const value = remoteAddress.trim().split('%')[0]
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
}

async function whoisViaCli(address: string, timeoutMs: number): Promise<string | null> {
  const raw = await runTailscale(['whois', '--json', address], timeoutMs)
  return raw === null ? null : peerNameFromWhois(raw)
}

/**
 * Pull the node name out of a `tailscale whois --json` payload.
 *
 * Exported for the test: the shape is Tailscale's, so pinning our reading of it
 * is the only way to notice if we are reading it wrong.
 */
export function peerNameFromWhois(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const node = isRecord(parsed.Node) ? parsed.Node : undefined
  const name = typeof node?.Name === 'string' ? node.Name : undefined
  if (name) return name.replace(/\.$/, '').slice(0, 256)
  const user = isRecord(parsed.UserProfile) ? parsed.UserProfile : undefined
  const login = typeof user?.LoginName === 'string' ? user.LoginName : undefined
  return login ? login.slice(0, 256) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
