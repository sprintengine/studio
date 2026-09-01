import { relative, resolve } from 'node:path';
// Shared safety rules for serving third-party entry code. Every entry bundle
// (entry.main, entry.renderer) must resolve strictly inside its module root —
// `..` traversal, absolute paths, and NUL bytes are rejected — and any message
// that might reach the renderer must not leak absolute filesystem paths.
export function resolveContainedEntry(moduleRoot, entryRelative, field) {
    const root = resolve(moduleRoot);
    const entryPath = resolve(root, entryRelative);
    const rootRelative = relative(root, entryPath);
    if (rootRelative.length === 0 ||
        rootRelative.startsWith('..') ||
        rootRelative.includes('\0') ||
        resolve(root, rootRelative) !== entryPath) {
        throw new Error(`${field} must resolve inside the module root.`);
    }
    return entryPath;
}
// The message-sanitation half lives in shared code (the renderer-side loader
// applies the same rule to its own load errors); re-exported here so main-side
// callers keep one import for both containment rules.
export { sanitizeEntryMessage } from '../../shared/modules/entry-messages';
