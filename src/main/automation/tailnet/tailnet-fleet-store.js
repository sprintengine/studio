import { chmodSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { normalizeTailnetScopes } from '../../../shared/tailnet';
// The tokens THIS machine holds for OTHER machines (MC-2167).
//
// The mirror image of `tailnet-devices.ts`, and deliberately not the same file:
// that one stores hashes of credentials other machines present to us, which is
// all a verifier needs. This one stores credentials we present elsewhere, which
// must survive as plaintext because there is nothing else to send. Mode 0600,
// same as the device store and the bridge's token file.
//
// A person can end that risk from either end: forget the connection here, or
// revoke the device on the machine that issued it. Revocation lands on our very
// next request, so the stored token becomes inert without us being told.
export const TAILNET_FLEET_FILENAME = 'tailnet-fleet-connections.json';
export function createTailnetFleetStore(options) {
    const now = options.now ?? (() => new Date());
    let connections = read(options.resolveUserDataDir(), options.log);
    function persist() {
        const path = join(options.resolveUserDataDir(), TAILNET_FLEET_FILENAME);
        writeFileSync(path, `${JSON.stringify({ version: 1, connections }, null, 2)}\n`, { mode: 0o600 });
        if (process.platform !== 'win32')
            chmodSync(path, 0o600);
    }
    function safePersist(context) {
        try {
            persist();
        }
        catch (error) {
            // Diagnostics only. Losing a last-connected timestamp must not fail the
            // browse a person is waiting on.
            options.log?.(`Could not write ${TAILNET_FLEET_FILENAME} (${context}): ${message(error)}`);
        }
    }
    return {
        list: () => connections.map(publicConnection),
        find: (connectionId) => connections.find((entry) => entry.id === connectionId) ?? null,
        add(input) {
            const stored = {
                id: `tnc_${randomBytes(9).toString('base64url')}`,
                machineName: input.machineName.slice(0, 120),
                endpoint: input.endpoint,
                deviceId: input.deviceId,
                deviceName: input.deviceName.slice(0, 120),
                scopes: normalizeTailnetScopes(input.scopes),
                pairedAt: now().toISOString(),
                lastConnectedAt: null,
                deviceToken: input.deviceToken,
            };
            // Pairing twice with the same machine issues a SECOND device over there,
            // so both records are real and both are listed. Silently replacing the
            // first would leave a device paired on the other machine that nothing
            // here could ever name for revocation.
            const previous = connections;
            connections = [...connections, stored];
            try {
                // Unlike last-seen, this write is the whole point of pairing: a token we
                // cannot persist is a pairing that will not survive a restart, so the
                // failure must reach the caller.
                persist();
            }
            catch (error) {
                // And it must not leave a connection listed that the next launch will
                // not have — the caller tells the person to revoke and pair again, and a
                // row still sitting in the list would contradict that advice.
                connections = previous;
                throw error;
            }
            return publicConnection(stored);
        },
        updateScopes(connectionId, scopes) {
            const entry = connections.find((candidate) => candidate.id === connectionId);
            if (!entry)
                return;
            const next = normalizeTailnetScopes(scopes);
            if (sameScopes(entry.scopes, next))
                return;
            entry.scopes = next;
            safePersist('scopes');
        },
        markConnected(connectionId) {
            const entry = connections.find((candidate) => candidate.id === connectionId);
            if (!entry)
                return;
            entry.lastConnectedAt = now().toISOString();
            safePersist('last-connected');
        },
        forget(connectionId) {
            const next = connections.filter((entry) => entry.id !== connectionId);
            if (next.length === connections.length)
                return false;
            connections = next;
            persist();
            return true;
        },
    };
}
function publicConnection(entry) {
    return {
        id: entry.id,
        machineName: entry.machineName,
        endpoint: entry.endpoint,
        deviceId: entry.deviceId,
        deviceName: entry.deviceName,
        scopes: [...entry.scopes],
        pairedAt: entry.pairedAt,
        lastConnectedAt: entry.lastConnectedAt,
    };
}
function sameScopes(left, right) {
    return left.length === right.length && left.every((scope, index) => scope === right[index]);
}
function read(userDataDir, log) {
    let raw;
    try {
        raw = readFileSync(join(userDataDir, TAILNET_FLEET_FILENAME), 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT')
            log?.(`Could not read ${TAILNET_FLEET_FILENAME}: ${message(error)}`);
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        const entries = isRecord(parsed) && Array.isArray(parsed.connections) ? parsed.connections : [];
        // A half-readable entry is dropped rather than repaired: a connection with a
        // guessed endpoint would send this machine's credential somewhere nobody chose.
        return entries.flatMap((entry) => (isStored(entry) ? [normalize(entry)] : []));
    }
    catch (error) {
        log?.(`${TAILNET_FLEET_FILENAME} is not valid JSON (${message(error)}); no machine is paired until it is fixed.`);
        return [];
    }
}
function isStored(value) {
    return (isRecord(value) &&
        typeof value.id === 'string' &&
        value.id.length > 0 &&
        typeof value.endpoint === 'string' &&
        value.endpoint.length > 0 &&
        typeof value.deviceToken === 'string' &&
        value.deviceToken.length > 0 &&
        typeof value.deviceId === 'string' &&
        typeof value.pairedAt === 'string');
}
function normalize(value) {
    return {
        id: value.id,
        machineName: typeof value.machineName === 'string' && value.machineName ? value.machineName.slice(0, 120) : value.endpoint,
        endpoint: value.endpoint,
        deviceId: value.deviceId,
        deviceName: typeof value.deviceName === 'string' ? value.deviceName.slice(0, 120) : '',
        scopes: normalizeTailnetScopes(value.scopes),
        pairedAt: value.pairedAt,
        lastConnectedAt: typeof value.lastConnectedAt === 'string' ? value.lastConnectedAt : null,
        deviceToken: value.deviceToken,
    };
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
