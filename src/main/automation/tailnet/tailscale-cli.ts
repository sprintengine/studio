import { execFile } from 'child_process'
import { existsSync } from 'fs'

// One way to reach Tailscale's local API, shared by whois (who is on the other
// end of a connection) and status (which machines exist on this tailnet).
//
// Going through the CLI rather than opening the tailscaled socket directly is
// deliberate: the socket's location differs across Linux packages, the macOS
// standalone app, and the sandboxed Mac App Store build (which uses a
// port+token handshake instead of a socket), and the CLI already resolves all
// of them. It is a thin client over the same local API.
//
// Every failure mode — no binary, a non-zero exit, a timeout — is the same
// answer: null. Callers turn that into "Tailscale is not available here", never
// into a guess about the tailnet.

/** Where the macOS app installs its CLI when it is not on PATH. */
const MACOS_CLI_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
]

function resolveTailscaleBinary(): string {
  for (const candidate of MACOS_CLI_PATHS) {
    if (existsSync(candidate)) return candidate
  }
  // Fall back to PATH resolution by execFile; a missing binary surfaces as an
  // execFile error, which the caller reads as null.
  return 'tailscale'
}

/** Run a Tailscale subcommand, or null when it is unavailable or fails. */
export function runTailscale(args: readonly string[], timeoutMs: number, maxBuffer?: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      resolveTailscaleBinary(),
      [...args],
      { timeout: timeoutMs, windowsHide: true, ...(maxBuffer ? { maxBuffer } : {}) },
      (error, stdout) => resolve(error ? null : stdout)
    )
  })
}

/**
 * A run whose failure the caller must explain rather than swallow.
 *
 * `runTailscale` collapses every failure to null, which is the right answer for
 * a read (no tailnet is no tailnet). A WRITE — `serve` turning a local port
 * into a tailnet URL — fails for reasons a person can act on: HTTPS is off for
 * the tailnet, the node is logged out, the daemon wants elevation. Those need
 * to reach the UI, so this variant keeps the exit code and stderr.
 *
 * CALLERS MUST NOT SURFACE OR LOG `stderr` VERBATIM. Tailscale writes auth keys
 * (`tskey-…`) and node names into it; `tailscale-serve.ts` classifies it into a
 * fixed label and drops the text. The field is here so that classification can
 * happen, not so the text can be shown.
 */
export type TailscaleRun = { ok: true; stdout: string } | { ok: false; stdout: string; stderr: string; timedOut: boolean }

export function runTailscaleResult(args: readonly string[], timeoutMs: number, maxBuffer?: number): Promise<TailscaleRun> {
  return new Promise((resolve) => {
    execFile(
      resolveTailscaleBinary(),
      [...args],
      { timeout: timeoutMs, windowsHide: true, ...(maxBuffer ? { maxBuffer } : {}) },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout })
          return
        }
        // execFile reports a timeout by killing the child; `killed` is the only
        // signal that separates "took too long" from "exited non-zero".
        const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
        resolve({ ok: false, stdout: stdout ?? '', stderr: stderr ?? '', timedOut })
      }
    )
  })
}
