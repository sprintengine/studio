import { isAbsolute, relative, resolve, sep } from 'path';
export function isPathInsideOrEqual(parentPath, targetPath) {
    const relativePath = relative(resolve(parentPath), resolve(targetPath));
    return (relativePath === ''
        || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..')));
}
export function uniqueResolved(paths) {
    return [...new Set(paths.map((path) => resolve(path)))];
}
export function isSafePathSegment(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== '.' && value !== '..';
}
export function safeSlug(value) {
    const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
    return slug.slice(0, 80) || 'command';
}
export function mobileActorId(deviceId) {
    return `mobile:${deviceId.replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, 120)}`;
}
