import { access } from 'fs/promises';
export function isMissingPathError(error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
export async function pathExists(targetPath) {
    const result = await checkWorkspaceFolder(targetPath);
    return result.ok;
}
function getFsErrorCode(error) {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
}
async function checkPathAccess(targetPath) {
    try {
        await access(targetPath);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, code: getFsErrorCode(error) };
    }
}
async function accessWithTimeout(targetPath, timeoutMs = 5000) {
    let timeoutId = null;
    try {
        const result = await Promise.race([
            checkPathAccess(targetPath),
            new Promise((resolve) => {
                timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
            }),
        ]);
        if (result === 'timeout') {
            return {
                ok: false,
                status: 'timeout',
                path: targetPath,
                checkedPath: targetPath,
                message: `Timed out checking workspace folder: ${targetPath}`,
            };
        }
        if (result.ok) {
            return {
                ok: true,
                status: 'ready',
                path: targetPath,
                checkedPath: targetPath,
                message: `Workspace folder is ready: ${targetPath}`,
            };
        }
        return {
            ok: false,
            status: result.code === 'EACCES' || result.code === 'EPERM' ? 'inaccessible' : 'missing',
            path: targetPath,
            checkedPath: targetPath,
            message: result.code === 'EACCES' || result.code === 'EPERM'
                ? `Workspace folder is not accessible: ${targetPath}`
                : `Workspace folder does not exist: ${targetPath}`,
            code: result.code,
        };
    }
    finally {
        if (timeoutId)
            clearTimeout(timeoutId);
    }
}
function toWindowsPath(dirPath) {
    const wslMatch = dirPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    if (!wslMatch) {
        return dirPath;
    }
    const [, drive, rest] = wslMatch;
    return `${drive.toUpperCase()}:\\${(rest ?? '').replace(/\//g, '\\')}`;
}
export async function checkWorkspaceFolder(targetPath) {
    const trimmedPath = targetPath?.trim();
    if (!trimmedPath) {
        return {
            ok: false,
            status: 'missing',
            path: '',
            checkedPath: '',
            message: 'Workspace folder path is empty.',
        };
    }
    const direct = await accessWithTimeout(trimmedPath);
    if (direct.ok || process.platform !== 'win32')
        return direct;
    const windowsPath = toWindowsPath(trimmedPath);
    if (windowsPath === trimmedPath)
        return direct;
    const normalized = await accessWithTimeout(windowsPath);
    return {
        ...normalized,
        path: trimmedPath,
        checkedPath: windowsPath,
        message: normalized.ok
            ? `Workspace folder is ready: ${trimmedPath}`
            : normalized.message,
    };
}
