import { runTailscale } from './tailscale-cli'
import { isRecord } from '../../../shared/records'

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
//
// The same answer is what a device token is bound to (see `verifyPeer` in
// `tailnet-devices.ts`): the node's stable ID, which Tailscale never reuses and
// which does not change when the machine is renamed. A null here therefore
// refuses a bound device rather than waving it through, so a failed lookup is
// only remembered briefly — long enough not to spawn the CLI per call, short
// enough that a hiccup does not lock a paired machine out for minutes.

const DEFAULT_TIMEOUT_MS = 2000
/** whois is stable for the life of a connection; re-asking per tool call would be a spawn per mutation. */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
/** A failed lookup is retried after this long, since a bound device is refused until one succeeds. */
const DEFAULT_FAILURE_TTL_MS = 10 * 1000

/**
 * Who a tailnet address belongs to, as `tailscale whois --json` reports it.
 *
 * `name` is for people (the node's MagicDNS name, else its owner's login) and
 * is what the audit and the device list show. `stableNodeId` is for the
 * binding, and is null only when Tailscale did not report one — which the
 * binding treats exactly like a failed lookup.
 */
export type TailnetPeerIdentity = {
  name: string | null
  /** `Node.StableID` — the node's permanent id, unchanged by renames and re-keys. */
  stableNodeId: string | null
  /** `UserProfile.LoginName` — the node's owner, or `tagged-devices` for a tagged node. */
  loginName: string | null
}

export type TailnetPeerResolver = {
  /** Tailscale node name for a remote address, or null when it cannot be resolved. */
  resolve(remoteAddress: string): Promise<string | null>
  /** The whole whois answer for a remote address, or null when it cannot be resolved. */
  identify(remoteAddress: string): Promise<TailnetPeerIdentity | null>
}

export function createTailnetPeerResolver(
  options: {
    now?: () => number
    timeoutMs?: number
    cacheTtlMs?: number
    failureTtlMs?: number
    /** Injected in tests; production runs `tailscale whois --json <addr>`. */
    runWhois?: (remoteAddress: string) => Promise<TailnetPeerIdentity | null>
    log?: (message: string) => void
  } = {},
): TailnetPeerResolver {
  const now = options.now ?? (() => Date.now())
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const failureTtlMs = Math.min(cacheTtlMs, options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS)
  const runWhois =
    options.runWhois ?? ((address: string) => whoisViaCli(address, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const cache = new Map<string, { value: TailnetPeerIdentity | null; expiresAt: number }>()

  async function identify(remoteAddress: string): Promise<TailnetPeerIdentity | null> {
    const address = normalizeAddress(remoteAddress)
    if (!address) return null
    const cached = cache.get(address)
    if (cached && cached.expiresAt > now()) return cached.value
    let value: TailnetPeerIdentity | null = null
    try {
      value = await runWhois(address)
    } catch (error) {
      options.log?.(`Tailscale whois failed for ${address}: ${message(error)}`)
    }
    // A failure is cached too, so a machine without the CLI does not spawn a
    // doomed process on every remote call — but for less time than an answer.
    cache.set(address, { value, expiresAt: now() + (value ? cacheTtlMs : failureTtlMs) })
    return value
  }

  return {
    identify,
    async resolve(remoteAddress): Promise<string | null> {
      return (await identify(remoteAddress))?.name ?? null
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

async function whoisViaCli(address: string, timeoutMs: number): Promise<TailnetPeerIdentity | null> {
  const raw = await runTailscale(['whois', '--json', address], timeoutMs)
  return raw === null ? null : peerIdentityFromWhois(raw)
}

/**
 * Read a `tailscale whois --json` payload.
 *
 * The shape is Tailscale's `apitype.WhoIsResponse`:
 * `{ "Node": { "StableID": "n…CNTRL", "Name": "mac-mini.tail1234.ts.net.", … },
 *    "UserProfile": { "LoginName": "dev@example.com", … }, "CapMap": … }`.
 * Exported for the test: pinning our reading of it is the only way to notice
 * if we are reading it wrong.
 */
export function peerIdentityFromWhois(raw: string): TailnetPeerIdentity | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const node = isRecord(parsed.Node) ? parsed.Node : undefined
  const user = isRecord(parsed.UserProfile) ? parsed.UserProfile : undefined
  const nodeName = typeof node?.Name === 'string' ? node.Name.replace(/\.$/, '').slice(0, 256) : ''
  const stableNodeId = typeof node?.StableID === 'string' ? node.StableID.trim().slice(0, 128) : ''
  const loginName = typeof user?.LoginName === 'string' ? user.LoginName.slice(0, 256) : ''
  if (!nodeName && !stableNodeId && !loginName) return null
  return {
    name: nodeName || loginName || null,
    stableNodeId: stableNodeId || null,
    loginName: loginName || null,
  }
}

/** The node name out of a whois payload — the display half of `peerIdentityFromWhois`. */
export function peerNameFromWhois(raw: string): string | null {
  return peerIdentityFromWhois(raw)?.name ?? null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
