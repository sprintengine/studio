import { type TailnetScope } from '../../../shared/tailnet';
import type { FleetConnection } from '../../../shared/tailnet-fleet';
export declare const TAILNET_FLEET_FILENAME = "tailnet-fleet-connections.json";
/** A stored connection, with the credential the public view omits. */
export type StoredFleetConnection = FleetConnection & {
    deviceToken: string;
};
export type TailnetFleetStore = {
    /** Public view: no tokens. This is what IPC returns. */
    list(): FleetConnection[];
    /** Internal view, for the client that must actually authenticate. */
    find(connectionId: string): StoredFleetConnection | null;
    add(input: {
        machineName: string;
        endpoint: string;
        deviceId: string;
        deviceName: string;
        deviceToken: string;
        scopes: TailnetScope[];
    }): FleetConnection;
    /** Record what the remote says our grants are now; they can narrow without us being told. */
    updateScopes(connectionId: string, scopes: TailnetScope[]): void;
    markConnected(connectionId: string): void;
    forget(connectionId: string): boolean;
};
export declare function createTailnetFleetStore(options: {
    resolveUserDataDir: () => string;
    now?: () => Date;
    log?: (message: string) => void;
}): TailnetFleetStore;
