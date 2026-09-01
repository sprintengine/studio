import { normalizeTailnetScopes, TAILNET_STRUCTURED_SCOPES, } from '../../../shared/tailnet';
import { createTailnetDeviceStore } from './tailnet-devices';
import { createTailnetGatewayServer } from './tailnet-gateway-server';
import { resolveTailnetInterface } from './tailnet-interface';
import { createTailnetPeerResolver } from './tailnet-peer-identity';
import { createTailnetPeerScanner } from './tailnet-peers';
import { readTailnetSettings, writeTailnetSettings } from './tailnet-settings';
export function createTailnetRemoteService(options) {
    const devices = (options.createDeviceStore ?? createTailnetDeviceStore)({
        resolveUserDataDir: options.resolveUserDataDir,
        log: options.log,
    });
    const peers = (options.createPeerResolver ?? (() => createTailnetPeerResolver({ log: options.log })))();
    const peerScanner = (options.createPeerScanner ?? (() => createTailnetPeerScanner({ log: options.log })))();
    const resolveBindAddress = options.resolveBindAddress ?? (() => resolveTailnetInterface()?.address ?? null);
    let settings = null;
    let lastError = null;
    let server = null;
    function loadSettings() {
        if (settings)
            return settings;
        const read = readTailnetSettings(options.resolveUserDataDir());
        settings = read.settings;
        if (read.error) {
            lastError = read.error;
            options.log?.(read.error);
        }
        return settings;
    }
    function getStatus() {
        const current = loadSettings();
        const bound = server?.address() ?? null;
        return {
            enabled: current.enabled,
            running: server?.isRunning() ?? false,
            endpoint: bound ? formatEndpoint(bound.address, bound.port) : null,
            port: current.port,
            tailnetAddress: resolveBindAddress(),
            lastError,
            devices: devices.listDevices(),
            pairing: devices.getPairingState(),
        };
    }
    async function startServer() {
        if (server?.isRunning())
            return;
        const current = loadSettings();
        if (!current.enabled)
            return;
        const bindAddress = resolveBindAddress();
        if (!bindAddress) {
            // Explicit refusal, not a fallback to another interface: the whole point
            // of this listener is that it is reachable ONLY over the tailnet.
            lastError =
                'Tailnet remote control is enabled but no Tailscale interface was found on this machine. Start Tailscale, then re-enable it.';
            options.log?.(lastError);
            return;
        }
        const next = createTailnetGatewayServer({
            bindAddress,
            port: current.port,
            serverName: options.serverName,
            serverVersion: options.serverVersion,
            resolveTools: options.resolveTools,
            isMutation: options.isMutation,
            devices,
            peers,
            terminals: options.terminals,
            onToolCall: options.onToolCall,
            log: options.log,
        });
        try {
            await next.start();
            server = next;
            lastError = null;
        }
        catch (error) {
            await next.stop().catch(() => { });
            lastError = `Tailnet remote control failed to start: ${message(error)}`;
            options.log?.(lastError);
        }
    }
    async function stopServer() {
        const current = server;
        server = null;
        if (!current)
            return;
        try {
            await current.stop();
        }
        catch (error) {
            lastError = `Tailnet remote control failed to stop cleanly: ${message(error)}`;
            options.log?.(lastError);
        }
    }
    return {
        async initialize() {
            await startServer();
            return getStatus();
        },
        getStatus,
        async setEnabled(enabled) {
            const current = loadSettings();
            settings = { ...current, enabled: enabled === true };
            try {
                writeTailnetSettings(options.resolveUserDataDir(), settings);
                lastError = null;
            }
            catch (error) {
                lastError = `Could not persist the tailnet remote setting: ${message(error)}`;
                options.log?.(lastError);
            }
            if (settings.enabled)
                await startServer();
            else {
                // Turning it off also drops any outstanding pairing: a code minted for
                // a listener that no longer answers is a credential with no purpose.
                devices.cancelPairing();
                await stopServer();
            }
            return getStatus();
        },
        offerPairing(input) {
            const requested = normalizeTailnetScopes(input?.scopes);
            // No scopes asked for means the structured-command set. The terminal tier
            // is never granted by default — it has to be asked for by name.
            const scopes = requested.length > 0 ? requested : [...TAILNET_STRUCTURED_SCOPES];
            const offer = devices.offerPairing({ scopes });
            const bound = server?.address() ?? null;
            return {
                token: offer.token,
                scopes: offer.scopes,
                expiresAt: offer.expiresAt,
                // Null while the listener is down: a QR pointing at nothing is worse
                // than none, and the caller can see from the status why.
                pairingUrl: bound ? pairingUrl(bound.address, bound.port, offer.token) : null,
            };
        },
        cancelPairing() {
            devices.cancelPairing();
            return getStatus();
        },
        revokeDevice(deviceId) {
            devices.revokeDevice(deviceId);
            return getStatus();
        },
        listPeers() {
            // The configured port, not the bound one: discovery probes the port THIS
            // machine would use, which is the convention the other machines follow.
            // A scan works with the local listener off — you can look for somewhere
            // to connect to without having opened your own door.
            return peerScanner.scan({ port: loadSettings().port });
        },
        resolvePeerName(address) {
            return peers.resolve(address);
        },
        notifyToolsListChanged() {
            server?.notifyToolsListChanged();
        },
        async shutdown() {
            await stopServer();
        },
    };
}
/** IPv6 literals need brackets before a port; IPv4 must not have them. */
export function formatEndpoint(address, port) {
    return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}
/**
 * One scannable string carrying everything a client needs to pair: where to
 * reach the listener, and the one-time code. A custom scheme rather than an
 * http URL so scanning it in a browser cannot accidentally spend the code.
 */
export function pairingUrl(address, port, token) {
    const query = new URLSearchParams({ endpoint: formatEndpoint(address, port), token });
    return `multicode-tailnet://pair?${query.toString()}`;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
