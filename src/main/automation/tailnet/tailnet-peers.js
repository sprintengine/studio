import { request } from 'http';
// The health path comes from the listener that serves it, so the probe and the
// route can never drift apart.
import { TAILNET_HEALTH_PATH } from './tailnet-gateway-server';
import { isTailnetAddress } from './tailnet-interface';
import { runTailscale } from './tailscale-cli';
// Which machines are on this tailnet, and which of them answer as a Studio.
//
// This is the CLIENT half of tailnet remote control: the listener (MC-2162)
// made a Studio reachable; discovery is what lets the other end pick a machine
// by name instead of being asked for an IP address. Remote control lives or
// dies on this moment: a list of machines you can point at is the difference
// between a feature people use and one they configure once and abandon.
//
// Two steps, in order:
//
//  1. `tailscale status --json` for the node list. That is Tailscale's own view
//     of the tailnet — we neither scan the network nor guess at addresses.
//  2. A probe of each peer's unauthenticated health endpoint on the known port.
//     The endpoint says only which product answers and which versions it
//     speaks, so probing costs a peer nothing and tells us nothing about it
//     beyond "something here speaks this transport".
//
// Every failure is reported as itself. No Tailscale means an empty list with a
// stated reason, never a fabricated peer and never a silent empty list that
// reads like "you have no machines".
/** The daemon is local; a slow answer means it is not healthy, not that we should wait. */
const STATUS_TIMEOUT_MS = 4000;
/** `tailscale status --json` on a large tailnet is well under this. */
const STATUS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** One RTT inside a WireGuard mesh. A peer that cannot answer this fast is not one we can drive. */
const PROBE_TIMEOUT_MS = 1500;
/** Enough bytes for the health payload and no more; anything larger is not our endpoint. */
const PROBE_MAX_BYTES = 4096;
/** Probes run against machines, not the network — a tailnet of hundreds should not open hundreds of sockets. */
const PROBE_CONCURRENCY = 12;
export function createTailnetPeerScanner(options = {}) {
    const runStatus = options.runStatus
        ?? (() => runTailscale(['status', '--json'], STATUS_TIMEOUT_MS, STATUS_MAX_BUFFER_BYTES));
    const probe = options.probe ?? probeStudioListener;
    return {
        async scan({ port }) {
            const raw = await runStatus();
            if (raw === null) {
                return {
                    tailscaleAvailable: false,
                    unavailableReason: 'Tailscale did not answer on this machine. Install Tailscale and sign in, then scan again.',
                    probedPort: port,
                    peers: [],
                };
            }
            const parsed = parseTailscaleStatus(raw);
            if (!parsed.ok) {
                options.log?.(`Tailscale status could not be read: ${parsed.reason}`);
                return { tailscaleAvailable: false, unavailableReason: parsed.reason, probedPort: port, peers: [] };
            }
            if (!parsed.backendRunning) {
                return {
                    tailscaleAvailable: false,
                    // Installed but not up is a different problem from not installed, and
                    // the fix is different too, so it gets its own sentence.
                    unavailableReason: 'Tailscale is installed but not connected. Start it and sign in, then scan again.',
                    probedPort: port,
                    peers: [],
                };
            }
            const probed = await mapWithLimit(parsed.peers, PROBE_CONCURRENCY, async (peer) => ({
                ...peer,
                // An offline peer is listed (so a person can see it exists and is
                // asleep) but not probed: the probe would only ever time out.
                studio: peer.online ? await probe(peer.address, port).catch(() => null) : null,
            }));
            return { tailscaleAvailable: true, unavailableReason: null, probedPort: port, peers: probed };
        },
    };
}
/**
 * Read `tailscale status --json` into the peers a picker can offer.
 *
 * Exported for the test: the shape is Tailscale's, so pinning our reading of it
 * is the only way to notice if we are reading it wrong. Fields we do not
 * understand are dropped rather than guessed — a node with no usable tailnet
 * address is not a machine anything can dial, so it is not listed.
 */
export function parseTailscaleStatus(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        return { ok: false, reason: `Tailscale reported a status this build could not read (${message(error)}).` };
    }
    if (!isRecord(parsed)) {
        return { ok: false, reason: 'Tailscale reported a status this build could not read.' };
    }
    const peers = [];
    const self = readNode(parsed.Self, true);
    if (self)
        peers.push(self);
    const peerMap = isRecord(parsed.Peer) ? parsed.Peer : {};
    for (const entry of Object.values(peerMap)) {
        const node = readNode(entry, false);
        if (node)
            peers.push(node);
    }
    // Self first, then the machines a person is most likely to want: reachable
    // ones before sleeping ones, and alphabetical within each group.
    peers.sort((left, right) => {
        if (left.isSelf !== right.isSelf)
            return left.isSelf ? -1 : 1;
        if (left.online !== right.online)
            return left.online ? -1 : 1;
        return left.hostName.localeCompare(right.hostName);
    });
    return { ok: true, backendRunning: parsed.BackendState === 'Running', peers };
}
function readNode(value, isSelf) {
    if (!isRecord(value))
        return null;
    const id = typeof value.ID === 'string' ? value.ID : null;
    const address = firstTailnetAddress(value.TailscaleIPs);
    if (!id || !address)
        return null;
    const dnsName = typeof value.DNSName === 'string' ? value.DNSName.replace(/\.$/u, '') : '';
    const hostName = typeof value.HostName === 'string' && value.HostName ? value.HostName : dnsName || address;
    return {
        id,
        hostName: hostName.slice(0, 256),
        dnsName: dnsName ? dnsName.slice(0, 256) : null,
        address,
        os: typeof value.OS === 'string' && value.OS ? value.OS.slice(0, 64) : null,
        // Tailscale reports Self without an Online field; a machine reading its own
        // status is by definition up.
        online: isSelf ? true : value.Online === true,
        isSelf,
    };
}
/**
 * The IPv4 tailnet address when the node has one, else its IPv6.
 *
 * The same allowlist the listener binds by: an address outside Tailscale's
 * ranges is not a tailnet address, whatever the daemon called it, and probing
 * one would send a request somewhere this feature has no business reaching.
 */
function firstTailnetAddress(value) {
    if (!Array.isArray(value))
        return null;
    const addresses = value.filter((entry) => typeof entry === 'string' && isTailnetAddress(entry));
    return addresses.find((entry) => !entry.includes(':')) ?? addresses[0] ?? null;
}
/**
 * Ask one peer whether a Studio listener answers on `port`.
 *
 * A peer is only reported as a Studio when the payload is exactly the health
 * shape: the right product string, an integer transport version, and a list of
 * protocol version strings. Anything else on that port — another service, an
 * error page, a captive portal — is not a Studio, and treating a stray 200 as
 * one would put an undrivable machine in the picker.
 */
export function probeStudioListener(address, port) {
    return new Promise((resolve) => {
        let settled = false;
        let call = null;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(deadline);
            call?.destroy();
            resolve(value);
        };
        // A hard deadline on top of the socket timeout. The socket's timeout fires
        // on INACTIVITY, so a peer trickling one byte at a time would hold this
        // probe — and one of the sweep's concurrency slots — for as long as it
        // liked. This bounds the whole exchange instead.
        const deadline = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
        try {
            call = request({
                host: address,
                port,
                path: TAILNET_HEALTH_PATH,
                method: 'GET',
                // The listener refuses any request carrying an Origin, and rightly so.
                headers: { accept: 'application/json' },
                timeout: PROBE_TIMEOUT_MS,
            }, (response) => {
                if (response.statusCode !== 200) {
                    response.destroy();
                    finish(null);
                    return;
                }
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    body += chunk;
                    if (body.length > PROBE_MAX_BYTES) {
                        response.destroy();
                        finish(null);
                    }
                });
                response.on('end', () => finish(readHealthPayload(body)));
                response.on('error', () => finish(null));
            });
            call.on('timeout', () => finish(null));
            call.on('error', () => finish(null));
            call.end();
        }
        catch {
            // An address Node refuses to dial at all is simply not a Studio, and must
            // not leave the deadline timer holding the process open.
            finish(null);
        }
    });
}
/**
 * Read a health payload, or null when it is not one.
 *
 * Exported for the test: this is the boundary where another machine's bytes
 * become something this app believes, so what it will and will not accept is
 * worth pinning. Only the three published fields are read; extra fields in a
 * future version are ignored rather than carried into the app.
 */
export function readHealthPayload(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return null;
    }
    if (!isRecord(parsed))
        return null;
    const product = typeof parsed.product === 'string' ? parsed.product : null;
    const transportVersion = parsed.transportVersion;
    const protocolVersions = parsed.protocolVersions;
    if (!product || !Number.isInteger(transportVersion) || !Array.isArray(protocolVersions))
        return null;
    const versions = protocolVersions.filter((entry) => typeof entry === 'string');
    if (versions.length !== protocolVersions.length)
        return null;
    return {
        product: product.slice(0, 128),
        transportVersion: transportVersion,
        protocolVersions: versions.map((entry) => entry.slice(0, 64)),
    };
}
/** Run `worker` over every item, never more than `limit` at once. */
async function mapWithLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (let index = next++; index < items.length; index = next++) {
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return results;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
