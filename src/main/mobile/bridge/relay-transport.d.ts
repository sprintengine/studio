import type { MobileRelayScope, MobileRelayTransport, RelayCommandDelivery, RelayCommandResultStatus, RelayCommandType, RelayConnectResult, RelayPairingChallengeResult } from './index';
export declare const RELAY_SUPPORTED_COMMANDS: RelayCommandType[];
export declare class FetchMobileRelayTransport implements MobileRelayTransport {
    connectDesktop(input: {
        relayUrl: string;
        accessToken: string;
        desktopInstanceId: string;
        displayName: string;
        commands: RelayCommandType[];
    }): Promise<RelayConnectResult>;
    createPairingChallenge(input: {
        relayUrl: string;
        relayToken: string;
        desktopRelaySessionId: string;
        requestedScopes: MobileRelayScope[];
    }): Promise<RelayPairingChallengeResult>;
    listPendingCommands(input: {
        relayUrl: string;
        relayToken: string;
        desktopRelaySessionId: string;
    }): Promise<RelayCommandDelivery[]>;
    postCommandResult(input: {
        relayUrl: string;
        relayToken: string;
        commandId: string;
        status: RelayCommandResultStatus;
        resultCode: string;
        summary: Record<string, unknown>;
    }): Promise<void>;
    revokeDevice(input: {
        relayUrl: string;
        accessToken: string;
        deviceId: string;
        reason: string;
    }): Promise<{
        revoked: true;
    }>;
}
