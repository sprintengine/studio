// Relay-path safety: the relay rejects any command-result summary that contains
// an absolute local filesystem path (multiauth src/relay/result-summary.ts ->
// containsLocalPath). These helpers mirror that guard so the desktop can redact
// paths from anything it sends the phone instead of having the whole payload
// rejected. Leaf module (no imports from snapshot/bridge) to stay cycle-free.
const localPathPatterns = [
    /\/(?:Users|home|private|var\/folders|Volumes|Applications|Library|opt|srv|mnt|tmp)\/[^\s"'=:()]*/gu,
    /[A-Za-z]:\\[^\s"'=:()]*/gu,
    /\\\\[^\\\s"'=:()]+\\[^\s"'=:()]*/gu,
];
export function redactLocalPaths(value) {
    return localPathPatterns.reduce((acc, pattern) => acc.replace(pattern, '[redacted-path]'), value);
}
export function containsLocalPath(value) {
    return localPathPatterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(value);
    });
}
export function deepRedactLocalPaths(value) {
    if (typeof value === 'string') {
        return redactLocalPaths(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => deepRedactLocalPaths(item));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = deepRedactLocalPaths(item);
        }
        return out;
    }
    return value;
}
