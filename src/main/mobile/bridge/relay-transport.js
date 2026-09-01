import { randomUUID } from 'crypto';
const mobileControlProtocolVersion = 2;
// Canonical relay command whitelist: parseRelayCommandEnvelope accepts these
// inbound and MobileRelayBridge advertises the same list on connect (imported
// from here — a stale duplicate in index.ts once silently dropped the three
// backlog commands, killing every backlog mutation at delivery). The Record
// keeps this exhaustive: adding a RelayCommandType member without listing it
// here is a compile error.
const RELAY_COMMAND_TYPES = {
    'snapshot.request': true,
    'artifact.read': true,
    'sprintengine.create': true,
    'task.start': true,
    'artifact.approve': true,
    'artifact.requestChanges': true,
    'agent.followup': true,
    'device.revoke': true,
    'backlog.update': true,
    'backlog.startSprintEngine': true,
    'backlog.create': true,
    'sprintengine.openPullRequest': true,
    'sprintengine.setAutomationMode': true,
    'automations.control': true,
};
export const RELAY_SUPPORTED_COMMANDS = Object.keys(RELAY_COMMAND_TYPES);
export class FetchMobileRelayTransport {
    async connectDesktop(input) {
        const payload = await relayJsonRequest(input.relayUrl, '/api/relay/desktop/connect', {
            token: input.accessToken,
            method: 'POST',
            body: {
                desktopInstanceId: input.desktopInstanceId,
                displayName: input.displayName,
                capabilities: {
                    mobileControlProtocolVersion,
                    commands: input.commands,
                },
            },
        });
        return {
            desktopRelaySessionId: requireRelayString(payload, 'desktopRelaySessionId'),
            relayToken: requireRelayString(payload, 'relayToken'),
            expiresAt: requireRelayString(payload, 'expiresAt'),
            heartbeatAfterSeconds: typeof payload.heartbeatAfterSeconds === 'number' ? payload.heartbeatAfterSeconds : undefined,
        };
    }
    async createPairingChallenge(input) {
        const payload = await relayJsonRequest(input.relayUrl, '/api/relay/desktop/pairing-challenges', {
            token: input.relayToken,
            method: 'POST',
            body: {
                desktopRelaySessionId: input.desktopRelaySessionId,
                requestedScopes: input.requestedScopes,
                relayUrl: input.relayUrl,
            },
        });
        const pairingPayload = optionalPairingPayload(payload, 'pairingPayload');
        return {
            pairingChallengeId: requireRelayString(payload, 'pairingChallengeId'),
            ...(typeof payload['manualPairingCode'] === 'string' && payload['manualPairingCode'].trim()
                ? { manualPairingCode: payload['manualPairingCode'].trim() }
                : {}),
            pairingUri: requireRelayString(payload, 'pairingUri'),
            ...(pairingPayload ? { pairingPayload } : {}),
            expiresAt: requireRelayString(payload, 'expiresAt'),
        };
    }
    async listPendingCommands(input) {
        const payload = await relayJsonRequest(input.relayUrl, '/api/relay/desktop/commands', {
            token: input.relayToken,
            method: 'POST',
            body: {
                desktopRelaySessionId: input.desktopRelaySessionId,
            },
        });
        const commands = payload.commands;
        if (!Array.isArray(commands)) {
            throw new Error('Relay command response did not include commands.');
        }
        return commands.map(parseRelayCommandDelivery);
    }
    async postCommandResult(input) {
        await relayJsonRequest(input.relayUrl, `/api/relay/commands/${encodeURIComponent(input.commandId)}/result`, {
            token: input.relayToken,
            method: 'POST',
            body: {
                status: input.status,
                resultCode: input.resultCode,
                summary: input.summary,
            },
        });
    }
    async revokeDevice(input) {
        const payload = await relayJsonRequest(input.relayUrl, `/api/relay/devices/${encodeURIComponent(input.deviceId)}/revoke`, {
            token: input.accessToken,
            method: 'POST',
            body: {
                reason: input.reason,
            },
        });
        if (payload.revoked !== true) {
            throw new Error('Relay revoke response did not confirm device revocation.');
        }
        return { revoked: true };
    }
}
async function relayJsonRequest(relayUrl, path, input) {
    const response = await fetch(`${relayUrl}${path}`, {
        method: input.method,
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${input.token}`,
            'content-type': 'application/json',
            'x-request-id': randomUUID(),
        },
        body: JSON.stringify(input.body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(readRelayErrorMessage(payload, response.status));
    }
    return payload;
}
function requireRelayString(payload, field) {
    const value = payload[field];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Relay response field ${field} is required.`);
    }
    return value;
}
function parseRelayCommandDelivery(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Relay command delivery must be an object.');
    }
    const delivery = input;
    if (!Object.hasOwn(delivery, 'envelope') || !Object.hasOwn(delivery, 'device')) {
        throw new Error('Relay command delivery must include envelope and device.');
    }
    return {
        envelope: parseRelayCommandEnvelope(delivery.envelope),
        device: parseRelayCommandDevice(delivery.device),
    };
}
function parseRelayCommandEnvelope(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Relay command envelope must be an object.');
    }
    const envelope = input;
    const commandType = requireRelayRecordString(envelope, 'commandType');
    if (!RELAY_SUPPORTED_COMMANDS.includes(commandType)) {
        throw new Error(`Unsupported relay command type: ${commandType}.`);
    }
    const payload = envelope.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Relay command payload must be an object.');
    }
    const expectedSnapshotVersion = envelope.expectedSnapshotVersion;
    if (expectedSnapshotVersion !== undefined && typeof expectedSnapshotVersion !== 'string') {
        throw new Error('Relay command expectedSnapshotVersion must be a string.');
    }
    return {
        desktopRelaySessionId: requireRelayRecordString(envelope, 'desktopRelaySessionId'),
        commandId: requireRelayRecordString(envelope, 'commandId'),
        commandType: commandType,
        issuedAt: requireRelayRecordString(envelope, 'issuedAt'),
        expiresAt: requireRelayRecordString(envelope, 'expiresAt'),
        ...(expectedSnapshotVersion ? { expectedSnapshotVersion } : {}),
        payload: payload,
    };
}
function parseRelayCommandDevice(input) {
    if (input === null)
        return null;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Relay command device must be an object or null.');
    }
    return input;
}
function requireRelayRecordString(payload, field) {
    const value = payload[field];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Relay command field ${field} is required.`);
    }
    return value;
}
function optionalPairingPayload(payload, field) {
    const value = payload[field];
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Relay response field ${field} must be an object.`);
    }
    const pairingPayload = value;
    const desktop = pairingPayload.desktop;
    if (!desktop || typeof desktop !== 'object' || Array.isArray(desktop)) {
        throw new Error(`Relay response field ${field}.desktop must be an object.`);
    }
    const desktopPayload = desktop;
    if (pairingPayload.mobileControlProtocolVersion !== mobileControlProtocolVersion) {
        throw new Error(`Relay response field ${field}.mobileControlProtocolVersion must be ${mobileControlProtocolVersion}.`);
    }
    return {
        mobileControlProtocolVersion,
        pairingChallengeId: requireRelayString(pairingPayload, 'pairingChallengeId'),
        relayUrl: requireRelayString(pairingPayload, 'relayUrl'),
        pairingSecret: requireRelayString(pairingPayload, 'pairingSecret'),
        expiresAt: requireRelayString(pairingPayload, 'expiresAt'),
        desktop: {
            displayName: requireRelayString(desktopPayload, 'displayName'),
            desktopInstanceId: requireRelayString(desktopPayload, 'desktopInstanceId'),
            desktopRelaySessionId: requireRelayString(desktopPayload, 'desktopRelaySessionId'),
        },
    };
}
function readRelayErrorMessage(payload, status) {
    const error = payload.error;
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return error.message;
    }
    return `Mobile relay request failed with HTTP ${status}.`;
}
