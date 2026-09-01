import type { AutomationServerStatus } from '../../shared/automation';
import type { McpToolRegistration } from '../../shared/modules/mcp-tools';
import type { TailnetPairingOfferView, TailnetRemoteStatus } from '../../shared/tailnet';
import type { TailnetPeerScan } from '../../shared/tailnet-peers';
import { type TailnetFleetService } from './tailnet/tailnet-fleet-service';
import type { TerminalRemoteHost } from '../terminal-remote-attach';
export declare const AUTOMATION_SERVER_INFO_FILENAME = "automation-server-info.json";
export declare const STUDIO_MCP_SERVER_INFO_FILENAME = "sprintengine-studio-mcp-info.json";
type AutomationServiceOptions = {
    resolveUserDataDir: () => string;
    appVersion: string;
    /**
     * The gateway's current tool set (core + module-contributed), evaluated per
     * request. Injected as a lazy resolver because the gateway is constructed at
     * startup module scope, BEFORE `loadMainModules` populates the module-host
     * tool registry — a captured array here could never see module tools, and
     * module enablement must be honored live (MC-1855).
     */
    resolveGatewayTools: () => McpToolRegistration[];
    /**
     * Watch-and-type access to this machine's terminals, for the tailnet
     * listener's terminal WebSocket (MC-2165). The LOCAL socket never gets it:
     * a local client already has the machine, and the terminal stream exists to
     * cross a network. Absent leaves that route refusing with a stated reason.
     */
    resolveTerminalHost?: () => TerminalRemoteHost;
    /** Absolute path of the shipped stdio bridge script, when the app knows it. */
    resolveBridgeScriptPath?: () => string | null;
    logDiagnostic?: (diagnostic: {
        level: 'warning';
        title: string;
        message: string;
        details?: string;
    }) => void;
};
export type AutomationService = ReturnType<typeof createAutomationService>;
export declare function createAutomationService(options: AutomationServiceOptions): {
    initialize: () => Promise<AutomationServerStatus>;
    getStatus: () => AutomationServerStatus;
    setEnabled: (_next: boolean) => Promise<AutomationServerStatus>;
    shutdown: () => Promise<void>;
    notifyToolsListChanged: () => void;
    getTailnetStatus: () => TailnetRemoteStatus;
    setTailnetEnabled: (next: boolean) => Promise<TailnetRemoteStatus>;
    offerTailnetPairing: (input?: {
        scopes?: unknown;
    }) => TailnetPairingOfferView;
    cancelTailnetPairing: () => TailnetRemoteStatus;
    revokeTailnetDevice: (deviceId: string) => TailnetRemoteStatus;
    listTailnetPeers: () => Promise<TailnetPeerScan>;
    /** The Fleet client: the machines this Studio drives (MC-2167). */
    fleet: () => TailnetFleetService;
};
export declare function resolveSocketPath(userDataDir: string, platform?: NodeJS.Platform, temporaryDir?: string): string;
export {};
