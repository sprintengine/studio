import { createHash } from 'crypto';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../../shared/product-identity';
import { readAutomationSettings, writeAutomationSettings } from './automation-settings';
import { createGatewayAuditStore } from './gateway-audit';
import { createMcpSocketServer } from './mcp-socket-server';
import { isStudioGatewayMutation } from './studio-gateway-tools';
import { createTailnetFleetService } from './tailnet/tailnet-fleet-service';
import { createTailnetRemoteService } from './tailnet/tailnet-service';
// Owns the always-on Studio MCP gateway lifecycle, local socket endpoint, and
// discovery files external clients read to find it. The old enabled setting is
// retained only as a compatibility API; it can no longer stop the gateway.
//
// It also owns the OPT-IN tailnet listener (MC-2162), which serves the same
// tool surface to paired devices on the Tailscale network. The two are
// deliberately asymmetric: the socket is infrastructure and always on; the
// tailnet listener is off until a person enables it, and stopping it never
// touches the socket.
export const AUTOMATION_SERVER_INFO_FILENAME = 'automation-server-info.json';
export const STUDIO_MCP_SERVER_INFO_FILENAME = 'sprintengine-studio-mcp-info.json';
// POSIX sun_path is ~104 bytes; long dev userData paths fall back to the
// per-user temp dir with a hash tying the socket to this profile.
const MAX_POSIX_SOCKET_PATH = 90;
export function createAutomationService(options) {
    let lastError = null;
    let server = null;
    let socketPath = null;
    let enabled = true;
    let settingsLoaded = false;
    // Both transports write the SAME audit file, so a mutation is one record
    // whichever door it came through — the connection identity is what differs.
    let audit = null;
    let tailnet = null;
    // The outbound half (MC-2167). Independent of the listener above: driving
    // another machine does not require having opened your own door, and a build
    // with remote control off can still be a Fleet client.
    let fleet = null;
    function loadSettings() {
        if (settingsLoaded)
            return;
        settingsLoaded = true;
        const read = readAutomationSettings(options.resolveUserDataDir());
        // MC-1743: the compatibility setting is read only for diagnostics. The
        // Studio gateway is infrastructure and is always enabled.
        enabled = true;
        if (read.error) {
            lastError = read.error;
            warn('Automation settings unreadable', read.error);
        }
    }
    function getStatus() {
        loadSettings();
        return {
            enabled,
            running: server?.isRunning() ?? false,
            socketPath: server?.isRunning() ? socketPath : null,
            lastError,
            bridgeScriptPath: options.resolveBridgeScriptPath?.() ?? null,
        };
    }
    /** Start the instance-global Studio MCP gateway with the app. */
    async function initialize() {
        loadSettings();
        await startServer();
        // Opt-in and independent: a tailnet listener that cannot start reports why
        // in its own status and never blocks the socket gateway the app depends on.
        await tailnetService().initialize();
        return getStatus();
    }
    async function setEnabled(_next) {
        loadSettings();
        enabled = true;
        try {
            // Compatibility API: old renderers may still call this toggle. Persist
            // the new invariant and keep the gateway running instead of allowing a
            // stale UI to disable every Studio agent's MCP contract.
            writeAutomationSettings(options.resolveUserDataDir(), { enabled: true });
        }
        catch (error) {
            lastError = `Could not persist the automation setting: ${message(error)}`;
            warn('Automation setting write failed', lastError);
        }
        await startServer();
        return getStatus();
    }
    function auditStore() {
        audit ??= createGatewayAuditStore({
            resolveUserDataDir: options.resolveUserDataDir,
            log: (text) => warn('Studio MCP audit', text),
        });
        return audit;
    }
    function tailnetService() {
        tailnet ??= createTailnetRemoteService({
            resolveUserDataDir: options.resolveUserDataDir,
            serverName: STUDIO_MCP_SERVER_ID,
            serverVersion: options.appVersion,
            resolveTools: options.resolveGatewayTools,
            isMutation: isStudioGatewayMutation,
            terminals: options.resolveTerminalHost?.(),
            onToolCall: ({ context, tool, args, durationMs, result, error }) => {
                if (!isStudioGatewayMutation(tool))
                    return;
                auditStore().record({ connection: context.metadata, tool, args, durationMs, result, error });
            },
            log: (text) => warn('Tailnet remote control', text),
        });
        return tailnet;
    }
    function fleetService() {
        fleet ??= createTailnetFleetService({
            resolveUserDataDir: options.resolveUserDataDir,
            resolvePeerName: (address) => tailnetService().resolvePeerName(address),
            log: (text) => warn('Tailnet fleet', text),
        });
        return fleet;
    }
    async function startServer() {
        if (server?.isRunning())
            return;
        const userDataDir = options.resolveUserDataDir();
        socketPath = resolveSocketPath(userDataDir);
        const audit = auditStore();
        const next = createMcpSocketServer({
            socketPath,
            serverName: STUDIO_MCP_SERVER_ID,
            serverVersion: options.appVersion,
            resolveTools: options.resolveGatewayTools,
            onToolCall: ({ context, tool, args, durationMs, result, error }) => {
                if (!isStudioGatewayMutation(tool))
                    return;
                audit.record({ connection: context.metadata, tool, args, durationMs, result, error });
            },
            log: (text) => warn('Automation server', text),
        });
        try {
            await next.start();
            writeServerInfo(userDataDir, socketPath, options.appVersion);
            server = next;
            lastError = null;
        }
        catch (error) {
            // A discovery write is part of startup: agents cannot use an
            // undiscoverable listener. Tear it down so retries do not leak a live
            // socket while status incorrectly reports stopped.
            await next.stop().catch(() => { });
            removeServerInfo(userDataDir);
            lastError = `Automation server failed to start: ${message(error)}`;
            warn('Automation server start failed', lastError);
        }
    }
    async function stopServer() {
        const current = server;
        server = null;
        if (current) {
            try {
                await current.stop();
            }
            catch (error) {
                lastError = `Automation server failed to stop cleanly: ${message(error)}`;
                warn('Automation server stop failed', lastError);
            }
        }
        removeServerInfo(options.resolveUserDataDir());
    }
    async function shutdown() {
        // Outbound sockets first: they are attachments on OTHER machines' ptys, and
        // closing them politely is what stops a remote runtime narrating to a
        // viewer that has quit.
        fleet?.shutdown();
        await tailnet?.shutdown();
        await stopServer();
    }
    function warn(title, details) {
        options.logDiagnostic?.({ level: 'warning', title, message: title, details });
    }
    /** A module enable/disable changed tool availability; tell connected clients. */
    function notifyToolsListChanged() {
        server?.notifyToolsListChanged();
        tailnet?.notifyToolsListChanged();
    }
    return {
        initialize,
        getStatus,
        setEnabled,
        shutdown,
        notifyToolsListChanged,
        getTailnetStatus: () => tailnetService().getStatus(),
        setTailnetEnabled: (next) => tailnetService().setEnabled(next),
        offerTailnetPairing: (input) => tailnetService().offerPairing(input),
        cancelTailnetPairing: () => tailnetService().cancelPairing(),
        revokeTailnetDevice: (deviceId) => tailnetService().revokeDevice(deviceId),
        listTailnetPeers: () => tailnetService().listPeers(),
        /** The Fleet client: the machines this Studio drives (MC-2167). */
        fleet: () => fleetService(),
    };
}
export function resolveSocketPath(userDataDir, platform = process.platform, temporaryDir = tmpdir()) {
    if (platform === 'win32') {
        return `\\\\.\\pipe\\multicode-automation-${profileHash(userDataDir)}`;
    }
    const direct = join(userDataDir, 'automation.sock');
    if (direct.length <= MAX_POSIX_SOCKET_PATH)
        return direct;
    return join(temporaryDir, `multicode-automation-${profileHash(userDataDir)}.sock`);
}
function profileHash(userDataDir) {
    return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12);
}
function writeServerInfo(userDataDir, socketPath, appVersion) {
    const body = `${JSON.stringify({
        serverId: STUDIO_MCP_SERVER_ID,
        serverName: STUDIO_MCP_SERVER_NAME,
        socketPath,
        transport: process.platform === 'win32' ? 'named-pipe' : 'unix-socket',
        protocol: 'mcp-jsonrpc-ndjson',
        pid: process.pid,
        appVersion,
        startedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    // Canonical discovery plus the legacy filename for existing bridge clients.
    for (const filename of [STUDIO_MCP_SERVER_INFO_FILENAME, AUTOMATION_SERVER_INFO_FILENAME]) {
        const path = join(userDataDir, filename);
        writeFileSync(path, body, { mode: 0o600 });
        if (process.platform !== 'win32')
            chmodSync(path, 0o600);
    }
}
function removeServerInfo(userDataDir) {
    for (const filename of [STUDIO_MCP_SERVER_INFO_FILENAME, AUTOMATION_SERVER_INFO_FILENAME]) {
        const infoPath = join(userDataDir, filename);
        if (!existsSync(infoPath))
            continue;
        try {
            unlinkSync(infoPath);
        }
        catch {
            // Best-effort: a stale info file is detectable via its recorded pid.
        }
    }
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
