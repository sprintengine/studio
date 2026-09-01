// Coercion for third-party config values. Every function here answers "is this
// actually a string / array of strings / record of strings", and returns
// nothing when it is not — a value is never invented, and a shape a CLI's own
// config does not have is never reported as one it does.
export function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
export function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string');
}
export function stringRecord(value) {
    const record = asRecord(value);
    if (!record)
        return undefined;
    const entries = Object.entries(record)
        .filter((entry) => typeof entry[1] === 'string' && Boolean(entry[0].trim()))
        .map(([key, item]) => [key.trim(), item]);
    return entries.length ? Object.fromEntries(entries) : undefined;
}
