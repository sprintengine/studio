import { type TailnetPairingOfferView, type TailnetRemoteStatus } from '../../../shared/tailnet';
import type { TailnetPeerScan } from '../../../shared/tailnet-peers';
import { type McpToolRegistration } from '../../../shared/modules/mcp-tools';
/**
 * The tailnet half of the automation service. Declared structurally so this
 * file does not import the service that (transitively) owns the tool set.
 */
export type TailnetToolsFrontDoor = {
    getTailnetStatus(): TailnetRemoteStatus;
    setTailnetEnabled(enabled: boolean): Promise<TailnetRemoteStatus>;
    offerTailnetPairing(input?: {
        scopes?: unknown;
    }): TailnetPairingOfferView;
    cancelTailnetPairing(): TailnetRemoteStatus;
    revokeTailnetDevice(deviceId: string): TailnetRemoteStatus;
    listTailnetPeers(): Promise<TailnetPeerScan>;
};
/** The `tailnet.*` tools that change state, for `isStudioGatewayMutation`. */
export declare const TAILNET_MUTATION_TOOL_NAMES: readonly string[];
export declare function createTailnetTools(options: {
    /**
     * Resolved per call, never captured: the tool set is built before the
     * automation service that owns the tailnet lifecycle exists. Null until it
     * does, which is answered rather than thrown.
     */
    resolveTailnet: () => TailnetToolsFrontDoor | null;
}): McpToolRegistration[];
