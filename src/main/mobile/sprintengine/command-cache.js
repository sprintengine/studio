import { createHash } from 'crypto';
const maxRememberedIdempotencyKeys = 500;
const idempotencyResults = new Map();
export function requestHashFor(command) {
    const hashInput = stableJsonStringify({
        protocolVersion: command.protocolVersion,
        type: command.type,
        expectedSnapshotVersion: command.expectedSnapshotVersion ?? null,
        payload: command.payload,
    });
    return createHash('sha256').update(hashInput).digest('hex');
}
export function cloneCommandResult(result) {
    return JSON.parse(JSON.stringify(result));
}
export function idempotencyKeyForCommand(workspaceRoot, command) {
    return `${workspaceRoot}:${command.deviceId}:${command.idempotencyKey}`;
}
export function rememberedCommandResult(key, requestHash) {
    const cached = idempotencyResults.get(key);
    if (!cached)
        return { status: 'miss' };
    if (cached.requestHash !== requestHash) {
        return { status: 'conflict' };
    }
    return {
        status: 'hit',
        result: cloneCommandResult(cached.result),
    };
}
export function rememberCommandResult(key, requestHash, result) {
    idempotencyResults.set(key, {
        requestHash,
        result: cloneCommandResult(result),
    });
    while (idempotencyResults.size > maxRememberedIdempotencyKeys) {
        const oldest = idempotencyResults.keys().next().value;
        if (!oldest)
            break;
        idempotencyResults.delete(oldest);
    }
}
function stableJsonStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`;
    const record = value;
    return `{${Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
        .join(',')}}`;
}
