import { type FleetAttachResult, type FleetBrowse, type FleetConnection, type FleetCreateTerminalResult, type FleetPairResult, type FleetRun, type FleetTerminalEvent } from '../../../shared/tailnet-fleet';
import { type TailnetFleetStore } from './tailnet-fleet-store';
export type TailnetFleetService = {
    listConnections(): FleetConnection[];
    pair(input: {
        pairingUrl: unknown;
        deviceName?: unknown;
    }): Promise<FleetPairResult>;
    forget(connectionId: unknown): FleetConnection[];
    browse(connectionId: unknown): Promise<FleetBrowse>;
    listRuns(connectionId: unknown, workspaceId: unknown): Promise<{
        ok: true;
        runs: FleetRun[];
    } | {
        ok: false;
        code: string;
        message: string;
    }>;
    createTerminal(input: {
        connectionId: unknown;
        workspaceId?: unknown;
        name?: unknown;
    }): Promise<FleetCreateTerminalResult>;
    /**
     * Attach a pane to a remote session. `emit` is the pane's event sink; the
     * caller owns its lifetime and calls `detach` when the pane goes away.
     */
    attachTerminal(input: {
        attachId: string;
        connectionId: unknown;
        sessionId: unknown;
        emit: (event: FleetTerminalEvent) => void;
    }): Promise<FleetAttachResult>;
    sendInput(attachId: unknown, data: unknown): void;
    resizeTerminal(attachId: unknown, cols: unknown, rows: unknown): void;
    detachTerminal(attachId: unknown): void;
    shutdown(): void;
};
export type TailnetFleetServiceOptions = {
    resolveUserDataDir: () => string;
    /** This machine's name, as the other end will list the pairing. */
    resolveDeviceName?: () => string;
    /** Tailscale node name for an address, so a machine is listed by name rather than by IP. */
    resolvePeerName?: (address: string) => Promise<string | null>;
    createStore?: (options: {
        resolveUserDataDir: () => string;
        log?: (message: string) => void;
    }) => TailnetFleetStore;
    log?: (message: string) => void;
};
export declare function createTailnetFleetService(options: TailnetFleetServiceOptions): TailnetFleetService;
