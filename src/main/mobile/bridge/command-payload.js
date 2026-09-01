export function stringPayload(payload, field) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Command payload must be an object.');
    }
    const value = payload[field];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} must be a non-empty string.`);
    }
    return value;
}
