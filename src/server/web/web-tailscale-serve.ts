import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describeServeDiagnostic,
  readServedPortsOrNull,
  SERVE_PORT_LADDER,
  shareLocalPort,
  unshareServePort,
  type TailscaleServeDeps,
} from '../../main/automation/tailnet/tailscale-serve'

// The web client on the tailnet, over HTTPS (R19; phase 9 spec, 6.6).
// `studio-server serve --web --tailscale-serve` asks tailscaled to publish the
// loopback listener at `https://<node>.<tailnet>.ts.net`: serve terminates TLS
// with a real certificate and proxies to loopback, so the listener never
// leaves loopback and the tailnet never sees plain HTTP. The name it publishes
// becomes one of the listener's origins.
//
// The port is serve's front door, 443, unless asked otherwise; the dev-server
// shares' ports are refused, so the two never take each other's. A port
// already serving something on this machine is left alone and the server does
// not start: someone else's serve configuration is not this server's to
// replace. The exception is this server's own mapping from an earlier run
// (recorded in `run/web-tailscale.json`), which a crash can leave behind
// pointing at a port the listener no longer holds.
//
// On a clean stop the mapping is turned off, and only while it still points
// at this run's listener.

export const DEFAULT_TAILSCALE_SERVE_PORT = 443
const RECORD_FILENAME = 'web-tailscale.json'

type ServeRecord = { servePort: number; localPort: number }

export type WebTailscaleServe = {
  /** `https://<node>.<tailnet>.ts.net[:port]`, the origin serve publishes. */
  origin: string
  servePort: number
  /** Turn the mapping off, if it is still this run's. */
  stop(): Promise<void>
}

export function checkTailscaleServePort(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '--tailscale-serve-port takes a port number.'
  if (SERVE_PORT_LADDER.includes(port))
    return `--tailscale-serve-port ${port} is one of the ports Studio shares dev servers on. Pick another, such as 443.`
  return null
}

function readRecord(runDir: string): ServeRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, RECORD_FILENAME), 'utf8')) as Partial<ServeRecord>
    return Number.isInteger(parsed.servePort) && Number.isInteger(parsed.localPort)
      ? { servePort: parsed.servePort!, localPort: parsed.localPort! }
      : null
  } catch {
    return null
  }
}

function writeRecord(runDir: string, record: ServeRecord): void {
  const file = join(runDir, RECORD_FILENAME)
  const staged = `${file}.${process.pid}.tmp`
  writeFileSync(staged, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameSync(staged, file)
}

function forgetRecord(runDir: string): void {
  try {
    unlinkSync(join(runDir, RECORD_FILENAME))
  } catch {
    // Already gone.
  }
}

export async function serveWebOnTailnet(input: {
  localPort: number
  servePort: number
  /** The data directory's owner-only `run/`. */
  runDir: string
  log?: (message: string) => void
  deps?: TailscaleServeDeps
}): Promise<WebTailscaleServe> {
  const { localPort, servePort, runDir } = input
  const served = await readServedPortsOrNull(input.deps)
  if (served === null) throw new Error(describeServeDiagnostic('unavailable'))
  const current = served.get(servePort)
  if (current !== undefined && current !== localPort) {
    const recorded = readRecord(runDir)
    const ours = recorded?.servePort === servePort && recorded.localPort === current
    if (!ours)
      throw new Error(
        `Tailscale already serves something else on HTTPS port ${servePort} of this machine. ` +
          `Pick another with --tailscale-serve-port, or turn that off with: tailscale serve --https=${servePort} off`,
      )
    input.log?.(`[web] replacing this server's own tailscale serve mapping from an earlier run on port ${servePort}`)
  }
  const shared = await shareLocalPort({ localPort, servePort }, input.deps)
  if (!shared.ok) throw new Error(shared.message)
  writeRecord(runDir, { servePort, localPort })
  const origin = new URL(shared.share.url).origin
  input.log?.(`[web] tailscale serve publishes the web client at ${origin}`)
  let stopped = false
  return {
    origin,
    servePort,
    async stop() {
      if (stopped) return
      stopped = true
      const now = await readServedPortsOrNull(input.deps)
      // Someone pointed the port elsewhere since: theirs now, and left alone.
      if (now !== null && now.get(servePort) !== localPort) {
        if (readRecord(runDir)?.localPort === localPort) forgetRecord(runDir)
        return
      }
      const result = await unshareServePort({ servePort }, input.deps)
      if (result.ok) forgetRecord(runDir)
      else input.log?.(`[web] tailscale serve on port ${servePort} was not turned off: ${result.message}`)
    },
  }
}

/**
 * Serve's identity headers (`Tailscale-User-Login`, `Tailscale-User-Name`),
 * read only from a request that came through the serve this server set up:
 * on the listener's loopback socket, addressed to serve's own name. Any other
 * request saying the same is a local program, and is not believed. The
 * identity labels a pairing request for the owner; the six digits are still
 * what lets a browser in (6.2).
 */
export function tailnetIdentityOf(
  headers: Record<string, string | string[] | undefined>,
  host: string,
  serveHosts: readonly string[],
): { login: string; name: string | null } | null {
  if (!serveHosts.includes(host.toLowerCase())) return null
  const login = headerText(headers['tailscale-user-login'])
  if (!login) return null
  return { login, name: headerText(headers['tailscale-user-name']) }
}

/** A header's text: serve writes non-ASCII as an RFC 2047 word. Control characters are dropped. */
function headerText(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null
  const word = /^=\?utf-8\?([qb])\?(.*)\?=$/iu.exec(raw.trim())
  let text = raw
  if (word) {
    const bytes =
      word[1].toLowerCase() === 'b'
        ? Buffer.from(word[2], 'base64')
        : Buffer.from(
            word[2]
              .replace(/_/gu, ' ')
              .replace(/=([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
            'latin1',
          )
    text = bytes.toString('utf8')
  }
  const clean = text
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, 120)
  return clean || null
}
