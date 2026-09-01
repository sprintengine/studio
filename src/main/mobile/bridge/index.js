import { MobileSprintEngineCommandService, } from '../sprintengine/command';
import { MobileSprintEngineSnapshotService } from '../sprintengine/snapshot';
import { validateSprintEngineStatePath } from '../sprintengine/state-path';
import { getErrorMessage } from '../../error-message';
import { hashSecret } from './crypto';
import { getDesktopDisplayName } from './desktop';
import { manualPairingValueFromRelayChallenge } from './pairing';
import { FetchMobileRelayTransport, RELAY_SUPPORTED_COMMANDS } from './relay-transport';
import { isMobileBridgePresence, } from './validation';
import { failedCommandResult, relaySummaryByteLength, relayResultSummaryMaxBytes, summarizeCommandResult, } from './command-results';
import { relayCommandTypeToMobile, relayEnvelopeToMobileCommand } from './relay-command';
import { dispatchArtifactRead } from './artifact-read';
import { dispatchDeviceRevoke } from './device-revoke';
import { dispatchSnapshotRequest } from './snapshot-request';
import { filterToDefaultSnapshotStatePaths } from '../../mobile-sprintengine-discovery';
import { authorizeRelayCommand } from './relay-auth';
import { upsertRelayDevice } from './relay-device';
import { getDefaultMobileBridgeStorePath, readMobileBridgeStore, writeMobileBridgeStore, } from './store';
import { emitMobileBridgeStateChanged, recordMobileBridgeDiagnostic, } from './notifications';
import { listActiveMobilePushTargets, listMobilePushRegistrations, registerMobilePushToken, revokeMobilePushRegistration, revokePushRegistrationsForDevice, } from './push';
const mobileControlProtocolVersion = 2;
const DEFAULT_RELAY_URL = 'https://multiauth-production.up.railway.app';
const RELAY_URL = process.env['MULTICODE_MOBILE_RELAY_URL']?.replace(/\/+$/u, '') || DEFAULT_RELAY_URL;
const USING_DEFAULT_RELAY_URL = RELAY_URL === DEFAULT_RELAY_URL;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60 * 1000;
const DEFAULT_COMMAND_POLL_INTERVAL_MS = 2_000;
// Idle backoff: once no command has arrived for the attention window, the poll
// interval doubles each tick up to the ceiling; any delivered command snaps it back
// to the base interval. The window covers the phone's own ~20s foreground cadence so
// an actively-viewed phone keeps the desktop fast.
const DEFAULT_COMMAND_POLL_CEILING_MS = 30_000;
const DEFAULT_COMMAND_POLL_ATTENTION_WINDOW_MS = 150_000;
const REQUESTED_SCOPES = [
    'snapshots.read',
    'artifacts.read',
    'sprintengines.create',
    'tasks.start',
    'artifacts.review',
    'agents.followUp',
    'devices.revoke',
    'backlog.update',
    'backlog.start',
    'backlog.create',
    'sprintengines.pr',
    'sprintengines.automation',
    'automations.control',
];
const REQUESTED_RELAY_SCOPES = [
    'relay:snapshot:read',
    'relay:artifact:read',
    'relay:sprintengine:create',
    'relay:task:start',
    'relay:artifact:review',
    'relay:agent:followup',
    'relay:device:revoke',
    'relay:backlog:update',
    'relay:backlog:start',
    'relay:backlog:create',
    'relay:sprintengine:pr',
    'relay:sprintengine:automation',
    'relay:automations:control',
];
const SUPPORTED_COMMANDS = [
    'snapshot.request',
    'artifact.read',
    'sprintengine.create',
    'task.start',
    'artifact.approve',
    'artifact.requestChanges',
    'agent.followUp',
    'device.revoke',
    'backlog.update',
    'backlog.startSprintEngine',
    'backlog.create',
    'sprintengine.openPullRequest',
    'sprintengine.setAutomationMode',
    'automations.control',
];
function normalizeRelayUrlUpdate(value) {
    if (value === undefined || value === null)
        return null;
    const trimmed = value.trim().replace(/\/+$/u, '');
    return trimmed || null;
}
function shouldReplaceStoredRelayUrl(value) {
    if (!USING_DEFAULT_RELAY_URL || !value)
        return false;
    try {
        const url = new URL(value);
        return ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
            (url.port === '3000' || url.port === ''));
    }
    catch {
        return false;
    }
}
export class MobileBridge {
    sessionProvider;
    enabled = false;
    relayStatus = 'disabled';
    desktopInstanceId = '';
    desktopRelaySessionId = null;
    relayTokenExpiresAt = null;
    nextReconnectAt = null;
    presence = 'offline';
    lastPresenceAt = null;
    pairingChallenge = null;
    pairedDevices = [];
    pushRegistrations = [];
    diagnostics = [];
    recentCommands = [];
    reconnectTimer = null;
    commandPollTimer = null;
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    loaded = false;
    relayToken = null;
    relayUrl;
    storePathOverride;
    accessTokenProvider;
    relayTransport;
    commandService;
    snapshotService;
    statePathsProvider;
    workspaceRootsProvider;
    commandPollIntervalMs;
    commandPollCeilingMs;
    commandPollAttentionWindowMs;
    commandPollIntervalMsCurrent;
    commandPollAttentionUntil = 0;
    activeRelayCommandIds = new Set();
    constructor(sessionProvider, options = {}) {
        this.sessionProvider = sessionProvider;
        this.relayUrl = options.relayUrl === undefined ? RELAY_URL : options.relayUrl?.replace(/\/+$/u, '') || null;
        this.storePathOverride = options.storePath;
        this.accessTokenProvider = options.accessTokenProvider ?? (async () => null);
        this.relayTransport = options.relayTransport ?? new FetchMobileRelayTransport();
        this.commandService = options.commandService ?? new MobileSprintEngineCommandService();
        this.snapshotService = options.snapshotService ?? new MobileSprintEngineSnapshotService();
        this.statePathsProvider = options.statePathsProvider ?? defaultSprintEngineStatePaths;
        this.workspaceRootsProvider = options.workspaceRootsProvider ?? (async () => []);
        this.commandPollIntervalMs = Math.max(250, options.commandPollIntervalMs ?? DEFAULT_COMMAND_POLL_INTERVAL_MS);
        this.commandPollCeilingMs = Math.max(this.commandPollIntervalMs, options.commandPollCeilingMs ?? DEFAULT_COMMAND_POLL_CEILING_MS);
        this.commandPollAttentionWindowMs = Math.max(0, options.commandPollAttentionWindowMs ?? DEFAULT_COMMAND_POLL_ATTENTION_WINDOW_MS);
        this.commandPollIntervalMsCurrent = this.commandPollIntervalMs;
    }
    async getState() {
        await this.load();
        this.expirePairingChallenge();
        return this.snapshot();
    }
    async updateSettings(update) {
        await this.load();
        const enabled = update && typeof update === 'object' ? update.enabled : undefined;
        const relayUrl = update && typeof update === 'object' && Object.hasOwn(update, 'relayUrl')
            ? normalizeRelayUrlUpdate(update.relayUrl)
            : undefined;
        if (relayUrl !== undefined && relayUrl !== this.relayUrl) {
            this.relayUrl = relayUrl;
            this.disconnect(this.enabled ? 'unconfigured' : 'disabled');
            this.recordDiagnostic('info', relayUrl ? 'relay_connected' : 'relay_not_configured', relayUrl ? 'Mobile relay URL updated.' : 'Mobile relay URL cleared.', false);
        }
        if (typeof enabled === 'boolean' && enabled !== this.enabled) {
            this.enabled = enabled;
            this.recordDiagnostic('info', enabled ? 'relay_not_configured' : 'mobile_bridge_disabled', enabled ? 'Mobile companion control enabled.' : 'Mobile companion control disabled.', enabled && !this.relayUrl);
            if (this.enabled) {
                this.presence = 'available';
                this.lastPresenceAt = new Date().toISOString();
                this.connectWithBackoff(0);
            }
            else {
                this.disconnect('disabled');
            }
        }
        await this.persist();
        if (this.enabled && relayUrl !== undefined && this.relayUrl) {
            this.connectWithBackoff(0);
        }
        this.emitStateChanged();
        return this.snapshot();
    }
    async requestPairingCode() {
        await this.load();
        this.assertEnabled();
        // With no active paired device the bridge stays idle (no relay traffic), so a
        // pairing request has to bring the connection up on demand before a challenge
        // can be minted. Already-connected callers pass straight through.
        await this.ensureRelayConnectedForPairing();
        this.assertRelayReady();
        const session = await this.sessionProvider();
        if (!session.authenticated) {
            this.recordDiagnostic('warning', 'unauthenticated', 'Sign in before pairing a mobile device.', false);
            throw new Error('Sign in before pairing a mobile device.');
        }
        const relayChallenge = await this.relayTransport.createPairingChallenge({
            relayUrl: this.relayUrl,
            relayToken: this.relayToken,
            desktopRelaySessionId: this.desktopRelaySessionId,
            requestedScopes: REQUESTED_RELAY_SCOPES,
        });
        const pairingCode = manualPairingValueFromRelayChallenge(relayChallenge);
        const expiresAt = relayChallenge.expiresAt;
        const pairingChallengeId = relayChallenge.pairingChallengeId;
        const pairingUri = relayChallenge.pairingUri;
        this.pairingChallenge = {
            pairingChallengeId,
            pairingCode,
            pairingUri,
            expiresAt,
            requestedScopes: REQUESTED_SCOPES,
            challengeHash: hashSecret(pairingCode),
        };
        this.recordDiagnostic('info', 'relay_connected', 'Created a relay-backed mobile pairing challenge.', false);
        await this.persist();
        // The pending challenge now gates polling on, so the desktop can receive the new
        // phone's first command. The awaited createPairingChallenge above yields, during
        // which the connect-time poll can have found no device/challenge yet and dropped
        // us to idle; the session is retained, so restore connected and arm the loop.
        if (this.relayStatus === 'idle') {
            this.relayStatus = 'connected';
        }
        this.startCommandPolling();
        this.emitStateChanged();
        return {
            pairingChallengeId,
            pairingCode,
            pairingUri,
            expiresAt,
            requestedScopes: REQUESTED_SCOPES,
        };
    }
    async listDevices() {
        await this.load();
        return this.pairedDevices;
    }
    async revokeDevice(deviceId, reason) {
        await this.load();
        this.assertEnabled();
        const trimmedDeviceId = deviceId.trim();
        const trimmedReason = reason?.trim();
        if (!trimmedDeviceId) {
            throw new Error('deviceId is required.');
        }
        const device = this.pairedDevices.find((candidate) => candidate.deviceId === trimmedDeviceId);
        if (!device) {
            this.recordDiagnostic('warning', 'device_revoked', `Device ${trimmedDeviceId} was not found for revocation.`, false);
            throw new Error('Paired mobile device was not found.');
        }
        await this.revokeDeviceAtRelay(trimmedDeviceId, trimmedReason ?? 'Revoked from Multicode desktop settings.');
        if (!device.revokedAt) {
            const revokedAt = new Date().toISOString();
            device.revokedAt = revokedAt;
            revokePushRegistrationsForDevice(this.pushRegistrations, device.deviceId, revokedAt);
            this.recordDiagnostic('info', 'device_revoked', trimmedReason ? `Revoked mobile device ${device.displayName}: ${trimmedReason}` : `Revoked mobile device ${device.displayName}.`, false);
        }
        // Revoking the last active device tears the connection back down to idle: with
        // nobody able to listen, holding a relay session and polling is pure waste.
        if (!this.shouldPollCommands()) {
            this.pauseRelayForNoDevices();
        }
        await this.persist();
        this.emitStateChanged();
        return device;
    }
    async registerPushToken(input) {
        await this.load();
        this.assertEnabled();
        const registration = registerMobilePushToken(this.pairedDevices, this.pushRegistrations, input);
        await this.persist();
        return registration;
    }
    async revokePushRegistration(registrationId) {
        await this.load();
        this.assertEnabled();
        const registration = revokeMobilePushRegistration(this.pushRegistrations, registrationId);
        await this.persist();
        return registration;
    }
    async listPushRegistrations() {
        await this.load();
        return listMobilePushRegistrations(this.pushRegistrations);
    }
    async listActivePushTargets() {
        await this.load();
        return listActiveMobilePushTargets(this.pairedDevices, this.pushRegistrations);
    }
    async publishPresence(presence) {
        await this.load();
        this.assertEnabled();
        if (!isMobileBridgePresence(presence)) {
            throw new Error('Unsupported mobile bridge presence value.');
        }
        this.presence = presence;
        this.lastPresenceAt = new Date().toISOString();
        this.emitStateChanged();
        return this.snapshot();
    }
    async getDiagnostics() {
        await this.load();
        return this.diagnostics;
    }
    shutdown() {
        this.clearReconnectTimer();
        this.clearCommandPollTimer();
        this.snapshotService.shutdown();
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        const persisted = await readMobileBridgeStore(this.storePath);
        this.enabled = persisted.enabled;
        this.relayUrl = shouldReplaceStoredRelayUrl(persisted.relayUrl)
            ? RELAY_URL
            : persisted.relayUrl ?? this.relayUrl;
        this.desktopInstanceId = persisted.desktopInstanceId;
        this.pairedDevices = persisted.pairedDevices;
        this.pushRegistrations = persisted.pushRegistrations;
        this.relayStatus = this.enabled ? 'unconfigured' : 'disabled';
        this.presence = this.enabled ? 'available' : 'offline';
        if (this.enabled) {
            this.connectWithBackoff(0);
        }
        await this.persist();
    }
    async persist() {
        await writeMobileBridgeStore(this.storePath, {
            enabled: this.enabled,
            relayUrl: this.relayUrl,
            desktopInstanceId: this.desktopInstanceId,
            pairedDevices: this.pairedDevices,
            pushRegistrations: this.pushRegistrations,
        });
    }
    async connectOnce() {
        if (!this.enabled)
            return;
        if (!this.relayUrl) {
            this.relayStatus = 'unconfigured';
            this.nextReconnectAt = null;
            this.recordDiagnostic('warning', 'relay_not_configured', 'Mobile relay URL is not configured.', true);
            this.emitStateChanged();
            return;
        }
        const session = await this.sessionProvider();
        if (!session.authenticated) {
            this.relayStatus = 'error';
            this.recordDiagnostic('warning', 'unauthenticated', 'Mobile relay connection requires a signed-in desktop session.', true);
            this.connectWithBackoff();
            return;
        }
        const accessToken = await this.accessTokenProvider();
        if (!accessToken) {
            this.relayStatus = 'error';
            this.recordDiagnostic('warning', 'unauthenticated', 'Mobile relay connection requires a desktop access token.', true);
            this.connectWithBackoff();
            return;
        }
        this.relayStatus = 'connecting';
        this.nextReconnectAt = null;
        this.emitStateChanged();
        try {
            const payload = await this.relayTransport.connectDesktop({
                relayUrl: this.relayUrl,
                accessToken,
                desktopInstanceId: this.desktopInstanceId,
                displayName: getDesktopDisplayName(),
                commands: RELAY_SUPPORTED_COMMANDS,
            });
            this.desktopRelaySessionId = payload.desktopRelaySessionId;
            this.relayToken = payload.relayToken;
            this.relayTokenExpiresAt = payload.expiresAt;
            this.relayStatus = 'connected';
            this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
            this.recordDiagnostic('info', 'relay_connected', 'Mobile relay connection established.', false);
            this.emitStateChanged();
            this.startCommandPolling();
            void this.publishSnapshotToRelay();
        }
        catch (error) {
            this.relayStatus = 'error';
            this.recordDiagnostic('error', 'relay_unavailable', getErrorMessage(error), true);
            this.connectWithBackoff();
        }
    }
    connectWithBackoff(delayMs = this.reconnectDelayMs) {
        this.clearReconnectTimer();
        if (!this.enabled) {
            this.relayStatus = 'disabled';
            this.nextReconnectAt = null;
            return;
        }
        if (!this.relayUrl) {
            this.relayStatus = 'unconfigured';
            this.nextReconnectAt = null;
            this.emitStateChanged();
            return;
        }
        // Demand gate: only hold a relay session while an active device can be listening,
        // or a pairing challenge is pending (so a new phone can complete pairing). With
        // neither, stay idle and issue zero relay traffic. requestPairingCode connects
        // directly via connectOnce, bypassing this gate to mint the first challenge.
        if (!this.shouldPollCommands()) {
            this.pauseRelayForNoDevices();
            this.emitStateChanged();
            return;
        }
        const boundedDelay = Math.min(Math.max(delayMs, 0), MAX_RECONNECT_DELAY_MS);
        this.relayStatus = boundedDelay > 0 ? 'retrying' : 'connecting';
        this.nextReconnectAt = new Date(Date.now() + boundedDelay).toISOString();
        this.reconnectTimer = setTimeout(() => {
            void this.connectOnce();
        }, boundedDelay);
        this.reconnectDelayMs = Math.min(Math.max(this.reconnectDelayMs * 2, INITIAL_RECONNECT_DELAY_MS), MAX_RECONNECT_DELAY_MS);
        this.emitStateChanged();
    }
    disconnect(status) {
        this.clearReconnectTimer();
        this.relayStatus = status;
        this.desktopRelaySessionId = null;
        this.relayToken = null;
        this.relayTokenExpiresAt = null;
        this.nextReconnectAt = null;
        this.presence = 'offline';
        this.lastPresenceAt = new Date().toISOString();
        this.pairingChallenge = null;
        this.clearCommandPollTimer();
    }
    clearReconnectTimer() {
        if (!this.reconnectTimer)
            return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }
    assertEnabled() {
        if (!this.enabled) {
            this.recordDiagnostic('warning', 'mobile_bridge_disabled', 'Mobile companion control is disabled.', false);
            throw new Error('Mobile companion control is disabled.');
        }
    }
    assertRelayReady() {
        if (!this.relayUrl || !this.desktopRelaySessionId || !this.relayToken || this.relayStatus !== 'connected') {
            this.recordDiagnostic('warning', 'relay_unavailable', 'Mobile relay session is not connected.', true);
            throw new Error('Mobile relay session is not connected.');
        }
    }
    expirePairingChallenge() {
        if (!this.pairingChallenge)
            return;
        if (Date.parse(this.pairingChallenge.expiresAt) > Date.now())
            return;
        this.pairingChallenge = null;
    }
    get capabilities() {
        return {
            protocolVersion: mobileControlProtocolVersion,
            deviceId: this.desktopInstanceId,
            commands: SUPPORTED_COMMANDS,
            capabilities: REQUESTED_SCOPES,
            artifactPreviewModes: ['text', 'markdown'],
            maxFollowUpCharacters: 2000,
            snapshotTtlMs: 10_000,
        };
    }
    snapshot() {
        this.expirePairingChallenge();
        return {
            enabled: this.enabled,
            relayStatus: this.relayStatus,
            relayUrl: this.relayUrl,
            desktopInstanceId: this.desktopInstanceId,
            desktopRelaySessionId: this.desktopRelaySessionId,
            relayTokenExpiresAt: this.relayTokenExpiresAt,
            nextReconnectAt: this.nextReconnectAt,
            presence: this.presence,
            lastPresenceAt: this.lastPresenceAt,
            pairingChallenge: this.pairingChallenge
                ? {
                    pairingChallengeId: this.pairingChallenge.pairingChallengeId,
                    expiresAt: this.pairingChallenge.expiresAt,
                    requestedScopes: this.pairingChallenge.requestedScopes,
                }
                : null,
            pairedDevices: this.pairedDevices,
            capabilities: this.capabilities,
            diagnostics: this.diagnostics,
            recentCommands: this.recentCommands,
            commandPollCadence: this.commandPollCadence(),
        };
    }
    recordCommandEvent(input) {
        const event = {
            id: `${input.commandId}:${Date.now()}`,
            commandId: input.commandId,
            commandType: input.commandType,
            deviceId: input.device?.deviceId ?? null,
            deviceName: input.device?.displayName ?? null,
            receivedAt: new Date().toISOString(),
            status: input.status,
        };
        this.recentCommands = [event, ...this.recentCommands].slice(0, 12);
        this.emitStateChanged();
    }
    completeCommandEvent(commandId, status, resultCode) {
        const completedAt = new Date().toISOString();
        this.recentCommands = this.recentCommands.map((event) => event.commandId === commandId ? { ...event, status, resultCode, completedAt } : event);
        this.emitStateChanged();
    }
    recordDiagnostic(level, code, message, retryable) {
        this.diagnostics = recordMobileBridgeDiagnostic(this.diagnostics, level, code, message, retryable);
    }
    emitStateChanged() {
        emitMobileBridgeStateChanged(this.snapshot());
    }
    get storePath() {
        if (this.storePathOverride)
            return this.storePathOverride;
        return getDefaultMobileBridgeStorePath();
    }
    hasActivePairedDevice() {
        return this.pairedDevices.some((device) => !device.revokedAt);
    }
    // The relay session is only worth holding while an active device can listen, or a
    // pairing challenge is pending so a new phone can complete pairing and send its
    // first command. Gates both the connection and the command poll loop.
    shouldPollCommands() {
        return this.hasActivePairedDevice() || this.pairingChallenge !== null;
    }
    // Stop polling and drop to idle when nothing can be listening. The relay session is
    // retained rather than torn down: a held session issues no traffic on its own (no
    // keepalive), and nulling the desktop token here would break the in-flight
    // postCommandResult of a command that self-revoked the last device. A fresh pairing
    // reconnects via connectOnce, replacing any stale session.
    pauseRelayForNoDevices() {
        this.clearReconnectTimer();
        this.clearCommandPollTimer();
        this.relayStatus = 'idle';
        this.nextReconnectAt = null;
        this.resetCommandPollCadence();
    }
    async ensureRelayConnectedForPairing() {
        if (this.relayStatus === 'connected' && this.relayToken && this.desktopRelaySessionId)
            return;
        await this.connectOnce();
    }
    resetCommandPollCadence() {
        this.commandPollIntervalMsCurrent = this.commandPollIntervalMs;
        this.commandPollAttentionUntil = 0;
    }
    // A delivered command means a human is looking: hold the fast base cadence for the
    // attention window before backoff resumes.
    markCommandActivity() {
        this.commandPollIntervalMsCurrent = this.commandPollIntervalMs;
        this.commandPollAttentionUntil = Date.now() + this.commandPollAttentionWindowMs;
    }
    nextCommandPollIntervalMs() {
        if (Date.now() < this.commandPollAttentionUntil)
            return this.commandPollIntervalMs;
        return Math.min(Math.max(this.commandPollIntervalMsCurrent * 2, this.commandPollIntervalMs), this.commandPollCeilingMs);
    }
    commandPollCadence() {
        if (!this.enabled || this.relayStatus !== 'connected' || !this.shouldPollCommands()) {
            return { intervalMs: 0, state: 'paused' };
        }
        const intervalMs = this.commandPollIntervalMsCurrent;
        return { intervalMs, state: intervalMs > this.commandPollIntervalMs ? 'decayed' : 'fast' };
    }
    startCommandPolling() {
        this.clearCommandPollTimer();
        // Fresh connection (or newly-armed pairing loop): start fast with an attention
        // window so the first command is delivered promptly, then decay if it stays quiet.
        this.commandPollIntervalMsCurrent = this.commandPollIntervalMs;
        this.commandPollAttentionUntil = Date.now() + this.commandPollAttentionWindowMs;
        this.commandPollTimer = setTimeout(() => {
            void this.pollRelayCommands();
        }, 0);
    }
    clearCommandPollTimer() {
        if (!this.commandPollTimer)
            return;
        clearTimeout(this.commandPollTimer);
        this.commandPollTimer = null;
    }
    scheduleNextCommandPoll() {
        this.clearCommandPollTimer();
        if (!this.enabled || this.relayStatus !== 'connected' || !this.shouldPollCommands()) {
            // Nothing left to poll for. If we were connected — last active device revoked, or
            // a pairing challenge expired unpaired — drop to idle. This runs in pollRelayCommands'
            // finally, after any in-flight postCommandResult, so the session is safe to retire.
            if (this.enabled && this.relayStatus === 'connected') {
                this.pauseRelayForNoDevices();
                this.emitStateChanged();
            }
            else {
                this.resetCommandPollCadence();
            }
            return;
        }
        const intervalMs = this.nextCommandPollIntervalMs();
        this.commandPollIntervalMsCurrent = intervalMs;
        this.commandPollTimer = setTimeout(() => {
            void this.pollRelayCommands();
        }, intervalMs);
    }
    async pollRelayCommands() {
        try {
            if (!this.enabled ||
                this.relayStatus !== 'connected' ||
                !this.relayUrl ||
                !this.relayToken ||
                !this.desktopRelaySessionId ||
                !this.shouldPollCommands()) {
                return;
            }
            const deliveries = await this.relayTransport.listPendingCommands({
                relayUrl: this.relayUrl,
                relayToken: this.relayToken,
                desktopRelaySessionId: this.desktopRelaySessionId,
            });
            if (deliveries.length > 0)
                this.markCommandActivity();
            for (const delivery of deliveries) {
                await this.processRelayCommandDelivery(delivery);
            }
        }
        catch (error) {
            this.relayStatus = 'retrying';
            this.recordDiagnostic('error', 'relay_unavailable', getErrorMessage(error), true);
            this.connectWithBackoff();
            return;
        }
        finally {
            this.scheduleNextCommandPoll();
        }
    }
    async processRelayCommandDelivery(delivery) {
        const { envelope, device } = normalizeRelayCommandDelivery(delivery);
        if (this.activeRelayCommandIds.has(envelope.commandId))
            return;
        this.activeRelayCommandIds.add(envelope.commandId);
        const commandType = relayCommandTypeToMobile(envelope.commandType);
        this.recordCommandEvent({
            commandId: envelope.commandId,
            commandType,
            device,
            status: 'received',
        });
        try {
            const result = await this.dispatchRelayCommand(envelope, device);
            this.completeCommandEvent(envelope.commandId, result.ok ? 'completed' : 'failed', result.ok ? 'ok' : result.error.code);
            await this.postCommandResult(envelope.commandId, result);
        }
        catch (error) {
            this.completeCommandEvent(envelope.commandId, 'failed', 'internal_error');
            await this.postCommandResult(envelope.commandId, failedCommandResult(envelope, 'internal_error', getErrorMessage(error)));
        }
        finally {
            this.activeRelayCommandIds.delete(envelope.commandId);
        }
    }
    async dispatchRelayCommand(envelope, device) {
        const commandType = relayCommandTypeToMobile(envelope.commandType);
        const authorizationError = authorizeRelayCommand({
            desktopRelaySessionId: this.desktopRelaySessionId,
            pairedDevices: this.pairedDevices,
            envelope,
            commandType,
            device,
        });
        if (authorizationError) {
            return failedCommandResult(envelope, authorizationError.code, authorizationError.message);
        }
        const { pairedDevice: activeDevice, inserted } = upsertRelayDevice(this.pairedDevices, device, mobileControlProtocolVersion);
        if (inserted)
            void this.persist().then(() => this.emitStateChanged());
        const command = relayEnvelopeToMobileCommand({
            envelope,
            commandType,
            deviceId: activeDevice.deviceId,
            protocolVersion: mobileControlProtocolVersion,
        });
        switch (commandType) {
            case 'snapshot.request':
                return dispatchSnapshotRequest({
                    command,
                    snapshotService: this.snapshotService,
                    desktopSessionId: this.desktopRelaySessionId ?? this.desktopInstanceId,
                    statePathsProvider: this.statePathsProvider,
                    workspaceRootsProvider: this.workspaceRootsProvider,
                });
            case 'artifact.read':
                return dispatchArtifactRead({
                    command,
                    snapshotService: this.snapshotService,
                    desktopSessionId: this.desktopRelaySessionId ?? this.desktopInstanceId,
                    statePathsProvider: this.statePathsProvider,
                });
            case 'device.revoke':
                return dispatchDeviceRevoke({
                    command,
                    revokeDevice: (deviceId, reason) => this.revokeDevice(deviceId, reason),
                });
            case 'sprintengine.create':
            case 'task.start':
            case 'artifact.approve':
            case 'artifact.requestChanges':
            case 'agent.followUp':
            case 'sprintengine.openPullRequest':
            case 'sprintengine.setAutomationMode':
                return this.dispatchSprintEngineMutation(command);
            case 'backlog.update':
            case 'backlog.startSprintEngine':
            case 'backlog.create':
            case 'automations.control':
                return this.dispatchWorkspaceMutation(command);
        }
    }
    async dispatchSprintEngineMutation(command) {
        const statePaths = await this.statePathsProvider();
        const allowedWorkspaceRoots = statePaths.map((statePath) => validateSprintEngineStatePath(statePath).workspaceRoot);
        return this.commandService.dispatch(command, {
            statePaths,
            allowedWorkspaceRoots,
        });
    }
    // Backlog and automations commands target workspace roots directly (no Sprint
    // Engine run is involved), so the allowed roots include the snapshot workspace
    // roots alongside any roots derived from configured run state paths. The phone
    // sends a workspace token, never a path; the handler resolves it against these
    // roots and fails closed when it matches none.
    async dispatchWorkspaceMutation(command) {
        const [statePaths, workspaceRoots] = await Promise.all([
            this.statePathsProvider(),
            this.workspaceRootsProvider(),
        ]);
        const allowedWorkspaceRoots = [
            ...statePaths.map((statePath) => validateSprintEngineStatePath(statePath).workspaceRoot),
            ...workspaceRoots,
        ];
        return this.commandService.dispatch(command, {
            statePaths,
            allowedWorkspaceRoots,
        });
    }
    async revokeDeviceAtRelay(deviceId, reason) {
        if (!this.relayUrl) {
            this.recordDiagnostic('warning', 'relay_not_configured', 'Mobile relay URL is not configured; device was not revoked.', true);
            throw new Error('Mobile relay URL is not configured.');
        }
        const accessToken = await this.accessTokenProvider();
        if (!accessToken) {
            this.recordDiagnostic('warning', 'unauthenticated', 'Mobile relay revocation requires a desktop access token.', true);
            throw new Error('Mobile relay revocation requires a desktop access token.');
        }
        try {
            await this.relayTransport.revokeDevice({
                relayUrl: this.relayUrl,
                accessToken,
                deviceId,
                reason,
            });
        }
        catch (error) {
            this.recordDiagnostic('error', 'relay_unavailable', `Relay device revocation failed: ${getErrorMessage(error)}`, true);
            throw error;
        }
    }
    async postCommandResult(commandId, result) {
        if (!this.relayUrl || !this.relayToken)
            return;
        const resultForRelay = this.ensureRelaySizedCommandResult(result);
        const summary = summarizeCommandResult(resultForRelay);
        await this.relayTransport.postCommandResult({
            relayUrl: this.relayUrl,
            relayToken: this.relayToken,
            commandId,
            status: resultForRelay.ok ? 'completed' : 'failed',
            resultCode: resultForRelay.ok ? 'OK' : resultForRelay.error.code.toUpperCase(),
            summary,
        });
    }
    ensureRelaySizedCommandResult(result) {
        if (!result.ok || result.commandType !== 'snapshot.request') {
            return result;
        }
        if (relaySummaryByteLength(result.data) > relayResultSummaryMaxBytes) {
            return failedSnapshotSizeResult(result);
        }
        const summary = summarizeCommandResult(result);
        if (relaySummaryByteLength(summary) <= relayResultSummaryMaxBytes) {
            return result;
        }
        return failedSnapshotSizeResult(result);
    }
    async publishSnapshotToRelay() {
        if (!this.relayTransport.publishSnapshot || !this.relayUrl || !this.relayToken || !this.desktopRelaySessionId)
            return;
        try {
            // The proactive publish is the unscoped default snapshot, so it sheds
            // terminal runs beyond the recent-N keep-window (item 1600) exactly as the
            // unscoped on-demand read does. The default composition (readSnapshot with no
            // `include`) also drops the switchboard/watchtower projections.
            const snapshot = await this.snapshotService.publishSnapshot({
                desktopSessionId: this.desktopRelaySessionId,
                statePaths: await filterToDefaultSnapshotStatePaths(await this.statePathsProvider()),
                workspaceRoots: await this.workspaceRootsProvider(),
            });
            if (snapshot) {
                await this.relayTransport.publishSnapshot({
                    relayUrl: this.relayUrl,
                    relayToken: this.relayToken,
                    desktopRelaySessionId: this.desktopRelaySessionId,
                    snapshot,
                });
            }
        }
        catch (error) {
            this.recordDiagnostic('warning', 'relay_unavailable', `Snapshot publication failed: ${getErrorMessage(error)}`, true);
        }
    }
}
function failedSnapshotSizeResult(result) {
    return failedCommandResult({
        commandId: result.commandId,
        type: result.commandType,
        ...(result.idempotencyKey ? { idempotencyKey: result.idempotencyKey } : {}),
    }, 'snapshot_too_large', 'Mobile control snapshot result exceeded the relay result summary size limit.');
}
function normalizeRelayCommandDelivery(delivery) {
    return { envelope: delivery.envelope, device: delivery.device };
}
async function defaultSprintEngineStatePaths() {
    return [];
}
