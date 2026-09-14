// Publishing a local dev server on the tailnet: the contract the renderer, the
// preload bridge and the mobile snapshot all read.
//
// A share is machine state, not app state. `tailscale serve --bg` outlives the
// Studio process, so this contract never describes "what we turned on this
// session" — it describes what the daemon reports right now. That is why every
// view carries the full list rather than a delta, and why `available` is a
// first-class field: a machine with Tailscale uninstalled is a normal answer,
// not an error.

export const TAILNET_SHARE_STATUS_CHANNEL = 'tailnet:share-status'
export const TAILNET_SHARE_PORT_CHANNEL = 'tailnet:share-port'
export const TAILNET_UNSHARE_PORT_CHANNEL = 'tailnet:unshare-port'

/** One published dev server. */
export type TailnetShareView = {
  /** The loopback port the dev server listens on. */
  localPort: number
  /** The HTTPS port Tailscale publishes it at. */
  servePort: number
  /** What a phone opens. */
  url: string
}

export type TailnetShareStatus = {
  /** False when Tailscale is absent, signed out, or the daemon is down. */
  available: boolean
  /** This machine's MagicDNS name, when it has one. */
  dnsName: string | null
  /** Every loopback port this machine currently publishes. */
  shares: TailnetShareView[]
  /**
   * True when the ladder is full, so the UI can explain a refusal before the
   * person triggers one.
   */
  ladderFull: boolean
}

/**
 * `share` is the mapping that now exists, and is null for an unshare — which
 * succeeds by leaving nothing behind. Callers read `status` for the new truth
 * either way.
 */
export type TailnetShareResult =
  | { ok: true; share: TailnetShareView | null; status: TailnetShareStatus }
  | { ok: false; message: string; status: TailnetShareStatus }

export const EMPTY_TAILNET_SHARE_STATUS: TailnetShareStatus = {
  available: false,
  dnsName: null,
  shares: [],
  ladderFull: false,
}
