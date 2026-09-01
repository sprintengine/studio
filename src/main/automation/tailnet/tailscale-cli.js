import { execFile } from 'child_process';
import { existsSync } from 'fs';
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
];
export function resolveTailscaleBinary() {
    for (const candidate of MACOS_CLI_PATHS) {
        if (existsSync(candidate))
            return candidate;
    }
    // Fall back to PATH resolution by execFile; a missing binary surfaces as an
    // execFile error, which the caller reads as null.
    return 'tailscale';
}
/** Run a Tailscale subcommand, or null when it is unavailable or fails. */
export function runTailscale(args, timeoutMs, maxBuffer) {
    return new Promise((resolve) => {
        execFile(resolveTailscaleBinary(), [...args], { timeout: timeoutMs, windowsHide: true, ...(maxBuffer ? { maxBuffer } : {}) }, (error, stdout) => resolve(error ? null : stdout));
    });
}
