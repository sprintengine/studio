import { MobileSprintEngineCommandService } from '../sprintengine/command';
import type { MobilePushRegistrationTarget } from '../sprintengine/activity';
import { MobileSprintEngineSnapshotService, type MobileControlSnapshot } from '../sprintengine/snapshot';
declare const mobileControlProtocolVersion: 2;
export type MobileControlCommandType = 'snapshot.request' | 'artifact.read' | 'sprintengine.create' | 'task.start' | 'artifact.approve' | 'artifact.requestChanges' | 'agent.followUp' | 'device.revoke' | 'backlog.update' | 'backlog.startSprintEngine' | 'backlog.create' | 'sprintengine.openPullRequest' | 'sprintengine.setAutomationMode' | 'automations.control';
export type MobileControlCapability = 'snapshots.read' | 'artifacts.read' | 'sprintengines.create' | 'tasks.start' | 'artifacts.review' | 'agents.followUp' | 'devices.revoke' | 'backlog.update' | 'backlog.start' | 'backlog.create' | 'sprintengines.pr' | 'sprintengines.automation' | 'automations.control';
export type MobileControlErrorCode = 'unsupported_protocol_version' | 'invalid_payload' | 'unauthenticated' | 'unauthorized' | 'device_revoked' | 'desktop_unavailable' | 'relay_unavailable' | 'command_not_supported' | 'command_expired' | 'duplicate_idempotency_key' | 'stale_snapshot' | 'sprintengine_not_found' | 'task_not_ready' | 'artifact_not_found' | 'path_not_allowed' | 'snapshot_too_large' | 'python_tool_failed' | 'internal_error';
export type MobileControlDevice = {
    protocolVersion: typeof mobileControlProtocolVersion;
    deviceId: string;
    displayName: string;
    platform: 'ios' | 'android' | 'web';
    appVersion: string;
    pairedAt: string;
    lastSeenAt?: string;
    revokedAt?: string;
    capabilities: MobileControlCapability[];
};
export type MobilePushProvider = 'apns' | 'fcm' | 'expo';
export type MobilePushRegistration = MobilePushRegistrationTarget & {
    protocolVersion: typeof mobileControlProtocolVersion;
    provider: MobilePushProvider;
    tokenHash: string;
    registeredAt: string;
    lastUsedAt?: string;
};
export type MobilePushRegistrationInput = {
    deviceId: string;
    provider: MobilePushProvider;
    token: string;
};
type MobileControlCapabilities = {
    protocolVersion: typeof mobileControlProtocolVersion;
    deviceId: string;
    commands: MobileControlCommandType[];
    capabilities: MobileControlCapability[];
    artifactPreviewModes: ('text' | 'markdown' | 'restrictedHtml')[];
    maxFollowUpCharacters: number;
    snapshotTtlMs: number;
};
export type MobileRelayScope = 'relay:presence:read' | 'relay:snapshot:read' | 'relay:artifact:read' | 'relay:artifact:review' | 'relay:sprintengine:create' | 'relay:task:start' | 'relay:agent:followup' | 'relay:push:register' | 'relay:device:revoke' | 'relay:backlog:update' | 'relay:backlog:start' | 'relay:backlog:create' | 'relay:sprintengine:pr' | 'relay:sprintengine:automation' | 'relay:automations:control';
export type RelayCommandType = 'snapshot.request' | 'artifact.read' | 'sprintengine.create' | 'task.start' | 'artifact.approve' | 'artifact.requestChanges' | 'agent.followup' | 'device.revoke' | 'backlog.update' | 'backlog.startSprintEngine' | 'backlog.create' | 'sprintengine.openPullRequest' | 'sprintengine.setAutomationMode' | 'automations.control';
export type RelayCommandEnvelope = {
    desktopRelaySessionId: string;
    commandId: string;
    commandType: RelayCommandType;
    issuedAt: string;
    expiresAt: string;
    expectedSnapshotVersion?: string;
    payload: Record<string, unknown>;
};
export type MobileRelayAuthenticatedDevice = {
    deviceId: string;
    userId?: string;
    organizationId?: string;
    mobileSessionId?: string;
    desktopRelaySessionId?: string;
    displayName?: string;
    platform?: 'ios' | 'android' | 'web' | 'other';
    appVersion?: string;
    pairedAt?: string;
    lastSeenAt?: string;
    revokedAt?: string;
    status?: 'active' | 'revoked';
    scopes?: MobileRelayScope[];
    capabilities?: MobileControlCapability[];
};
export type RelayCommandDelivery = {
    envelope: RelayCommandEnvelope;
    device: MobileRelayAuthenticatedDevice | null;
};
export type RelayConnectResult = {
    desktopRelaySessionId: string;
    relayToken: string;
    expiresAt: string;
    heartbeatAfterSeconds?: number;
};
export type RelayPairingChallengeResult = {
    pairingChallengeId: string;
    manualPairingCode?: string;
    pairingUri: string;
    pairingPayload?: {
        mobileControlProtocolVersion: 2;
        pairingChallengeId: string;
        relayUrl: string;
        pairingSecret: string;
        expiresAt: string;
        desktop: {
            displayName: string;
            desktopInstanceId: string;
            desktopRelaySessionId: string;
        };
    };
    expiresAt: string;
};
export type RelayCommandResultStatus = 'completed' | 'failed';
export type MobileRelayTransport = {
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
    publishSnapshot?(input: {
        relayUrl: string;
        relayToken: string;
        desktopRelaySessionId: string;
        snapshot: MobileControlSnapshot;
    }): Promise<void>;
};
export type MobileBridgeRelayStatus = 'disabled' | 'unconfigured' | 'idle' | 'connecting' | 'connected' | 'retrying' | 'error';
export type MobileBridgeCommandPollCadence = {
    intervalMs: number;
    state: 'paused' | 'fast' | 'decayed';
};
export type MobileBridgePresence = 'available' | 'busy' | 'idle' | 'offline';
export type MobileBridgeDiagnosticEntry = {
    id: string;
    timestamp: string;
    level: 'info' | 'warning' | 'error';
    code: MobileControlErrorCode | 'mobile_bridge_disabled' | 'relay_not_configured' | 'relay_connected';
    message: string;
    retryable: boolean;
};
export type MobileBridgeCommandEvent = {
    id: string;
    commandId: string;
    commandType: MobileControlCommandType;
    deviceId: string | null;
    deviceName: string | null;
    receivedAt: string;
    completedAt?: string;
    status: 'received' | 'completed' | 'failed';
    resultCode?: string;
};
export type MobileBridgePairingChallenge = {
    pairingChallengeId: string;
    pairingCode: string;
    pairingUri: string;
    expiresAt: string;
    requestedScopes: MobileControlCapability[];
};
export type MobileBridgeState = {
    enabled: boolean;
    relayStatus: MobileBridgeRelayStatus;
    relayUrl: string | null;
    desktopInstanceId: string;
    desktopRelaySessionId: string | null;
    relayTokenExpiresAt: string | null;
    nextReconnectAt: string | null;
    presence: MobileBridgePresence;
    lastPresenceAt: string | null;
    pairingChallenge: Omit<MobileBridgePairingChallenge, 'pairingCode' | 'pairingUri'> | null;
    pairedDevices: MobileControlDevice[];
    capabilities: MobileControlCapabilities;
    diagnostics: MobileBridgeDiagnosticEntry[];
    recentCommands: MobileBridgeCommandEvent[];
    commandPollCadence: MobileBridgeCommandPollCadence;
};
export type MobileBridgeSettingsUpdate = {
    enabled?: boolean;
    relayUrl?: string | null;
};
type DesktopSessionProvider = () => Promise<{
    authenticated: boolean;
    session?: {
        id: string;
        expiresAt: string;
    };
}>;
type DesktopAccessTokenProvider = () => Promise<string | null>;
type SprintEngineStatePathsProvider = () => Promise<string[]>;
type MobileWorkspaceRootsProvider = () => Promise<string[]>;
export type MobileBridgeOptions = {
    relayUrl?: string | null;
    storePath?: string;
    accessTokenProvider?: DesktopAccessTokenProvider;
    relayTransport?: MobileRelayTransport;
    commandService?: MobileSprintEngineCommandService;
    snapshotService?: MobileSprintEngineSnapshotService;
    statePathsProvider?: SprintEngineStatePathsProvider;
    workspaceRootsProvider?: MobileWorkspaceRootsProvider;
    commandPollIntervalMs?: number;
    commandPollCeilingMs?: number;
    commandPollAttentionWindowMs?: number;
};
export declare class MobileBridge {
    private readonly sessionProvider;
    private enabled;
    private relayStatus;
    private desktopInstanceId;
    private desktopRelaySessionId;
    private relayTokenExpiresAt;
    private nextReconnectAt;
    private presence;
    private lastPresenceAt;
    private pairingChallenge;
    private pairedDevices;
    private pushRegistrations;
    private diagnostics;
    private recentCommands;
    private reconnectTimer;
    private commandPollTimer;
    private reconnectDelayMs;
    private loaded;
    private relayToken;
    private relayUrl;
    private readonly storePathOverride?;
    private readonly accessTokenProvider;
    private readonly relayTransport;
    private readonly commandService;
    private readonly snapshotService;
    private readonly statePathsProvider;
    private readonly workspaceRootsProvider;
    private readonly commandPollIntervalMs;
    private readonly commandPollCeilingMs;
    private readonly commandPollAttentionWindowMs;
    private commandPollIntervalMsCurrent;
    private commandPollAttentionUntil;
    private readonly activeRelayCommandIds;
    constructor(sessionProvider: DesktopSessionProvider, options?: MobileBridgeOptions);
    getState(): Promise<MobileBridgeState>;
    updateSettings(update: MobileBridgeSettingsUpdate): Promise<MobileBridgeState>;
    requestPairingCode(): Promise<MobileBridgePairingChallenge>;
    listDevices(): Promise<MobileControlDevice[]>;
    revokeDevice(deviceId: string, reason?: string): Promise<MobileControlDevice>;
    registerPushToken(input: MobilePushRegistrationInput): Promise<MobilePushRegistration>;
    revokePushRegistration(registrationId: string): Promise<MobilePushRegistration>;
    listPushRegistrations(): Promise<MobilePushRegistration[]>;
    listActivePushTargets(): Promise<MobilePushRegistrationTarget[]>;
    publishPresence(presence: MobileBridgePresence): Promise<MobileBridgeState>;
    getDiagnostics(): Promise<MobileBridgeDiagnosticEntry[]>;
    shutdown(): void;
    private load;
    private persist;
    private connectOnce;
    private connectWithBackoff;
    private disconnect;
    private clearReconnectTimer;
    private assertEnabled;
    private assertRelayReady;
    private expirePairingChallenge;
    private get capabilities();
    private snapshot;
    private recordCommandEvent;
    private completeCommandEvent;
    private recordDiagnostic;
    private emitStateChanged;
    private get storePath();
    private hasActivePairedDevice;
    private shouldPollCommands;
    private pauseRelayForNoDevices;
    private ensureRelayConnectedForPairing;
    private resetCommandPollCadence;
    private markCommandActivity;
    private nextCommandPollIntervalMs;
    private commandPollCadence;
    private startCommandPolling;
    private clearCommandPollTimer;
    private scheduleNextCommandPoll;
    private pollRelayCommands;
    private processRelayCommandDelivery;
    private dispatchRelayCommand;
    private dispatchSprintEngineMutation;
    private dispatchWorkspaceMutation;
    private revokeDeviceAtRelay;
    private postCommandResult;
    private ensureRelaySizedCommandResult;
    private publishSnapshotToRelay;
}
export {};
