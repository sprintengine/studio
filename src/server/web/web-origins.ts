// Who may talk to the web listener, by `Host` and `Origin` (phase 9 spec, 6.3;
// decisions R14 and R16).
//
// The listener binds loopback only, so the network cannot reach it; what can
// is every page open in the person's browser. Two rules hold those pages off:
//
// - `Host` must name this listener: a loopback name with its port, or a host
//   from a configured public origin (`tailscale serve`'s HTTPS name). A page on
//   a hostile name that resolves to 127.0.0.1 (DNS rebinding) arrives with its
//   own name in `Host` and is refused before anything is read.
// - On every WebSocket upgrade and every request that is not a GET or HEAD,
//   `Origin` must equal one of this listener's own origins exactly: scheme,
//   host and port. Any other local port is the same *site* as this one, so
//   `SameSite=Strict` cookies ride along from a dev server on
//   `127.0.0.1:3000`; the port in the origin is what refuses it. A missing
//   `Origin` on an upgrade is a client that is not a browser, which is
//   allowed only with a ticket, never on a cookie alone.
//
// The tailnet phone lane keeps refusing any request that carries an `Origin`;
// this handler shares no code path with it.

export type WebOriginPolicy = {
  /** The port the loopback listener is bound to. */
  port: number
  /** Origins added by configuration (`--public-origin`, or the `tailscale serve` HTTPS name). */
  publicOrigins: readonly string[]
  /** The renderer dev server's origin, accepted only when the server was started with `--dev`. */
  devOrigin?: string | null
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const

/**
 * An origin as the browser sends it: scheme, host, and a port only when it is
 * not the scheme's default. Null for anything that is not an http(s) origin.
 */
export function normalizeOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null
  return url.origin
}

/** The `Host` header each allowed origin arrives with (host and port as the browser writes them). */
function hostOf(origin: string): string {
  return new URL(origin).host
}

export function allowedOrigins(policy: WebOriginPolicy): Set<string> {
  const origins = new Set<string>(LOOPBACK_HOSTS.map((host) => `http://${host}:${policy.port}`))
  for (const origin of policy.publicOrigins) {
    const normalized = normalizeOrigin(origin)
    if (normalized) origins.add(normalized)
  }
  if (policy.devOrigin) {
    const normalized = normalizeOrigin(policy.devOrigin)
    if (normalized) origins.add(normalized)
  }
  return origins
}

export function allowedHosts(policy: WebOriginPolicy): Set<string> {
  const hosts = new Set<string>(LOOPBACK_HOSTS.map((host) => `${host}:${policy.port}`))
  for (const origin of policy.publicOrigins) {
    const normalized = normalizeOrigin(origin)
    if (normalized) hosts.add(hostOf(normalized))
  }
  // The renderer dev server proxies `/ws` and `/api` here with its own `Host`.
  const dev = policy.devOrigin ? normalizeOrigin(policy.devOrigin) : null
  if (dev) hosts.add(hostOf(dev))
  return hosts
}

export type WebRequestFacts = {
  method: string
  host: string | undefined
  origin: string | undefined
  /** A WebSocket upgrade, rather than an ordinary request. */
  upgrade: boolean
  /** The request carries a single-use ticket (an embed, an SDK client), not only a cookie. */
  ticket: boolean
}

export type WebGate = { ok: true } | { ok: false; status: number; code: string }

/** Whether a request may go further, by its `Host` and `Origin` alone. */
export function gateWebRequest(facts: WebRequestFacts, policy: WebOriginPolicy): WebGate {
  const host = facts.host?.toLowerCase()
  if (!host || !allowedHosts(policy).has(host)) return { ok: false, status: 421, code: 'host_not_allowed' }
  const safe = !facts.upgrade && (facts.method === 'GET' || facts.method === 'HEAD')
  if (facts.origin === undefined) {
    if (safe) return { ok: true }
    // A browser sends `Origin` on every upgrade and every unsafe request; a
    // request without one is a program, which proves itself with a ticket.
    if (facts.upgrade && facts.ticket) return { ok: true }
    return { ok: false, status: 403, code: 'origin_required' }
  }
  // `Origin: null` (a sandboxed frame, a file) is never one of ours.
  const origin = normalizeOrigin(facts.origin)
  if (!origin || !allowedOrigins(policy).has(origin)) return { ok: false, status: 403, code: 'origin_not_allowed' }
  return { ok: true }
}

/** The origin a request was made to, from its `Host`, as this listener serves it (for redirects and the CSP). */
export function requestOrigin(host: string, policy: WebOriginPolicy): string {
  for (const origin of policy.publicOrigins) {
    const normalized = normalizeOrigin(origin)
    if (normalized && hostOf(normalized) === host.toLowerCase()) return normalized
  }
  return `http://${host.toLowerCase()}`
}
