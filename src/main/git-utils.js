import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
function removeLineEndingWarnings(output) {
    return output
        .split(/\r?\n/)
        .filter((line) => !/^warning: in the working copy of '.+', (?:LF|CRLF) will be replaced by (?:LF|CRLF) the next time Git touches it$/.test(line.trim()))
        .join('\n')
        .trim();
}
// LC_ALL=C pins git's messages to English: callers branch on stderr text
// (e.g. "not fully merged" → force-delete escalation), which localized git
// would silently break. Paths are bytes to git, so content is unaffected.
function gitEnv(overrides) {
    return { ...process.env, LC_ALL: 'C', ...overrides };
}
export async function runGit(cwd, args) {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env: gitEnv(),
    });
    return stdout;
}
export async function runGitCommand(cwd, args, envOverrides) {
    try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
            encoding: 'utf8',
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
            env: gitEnv(envOverrides),
        });
        return { ok: true, stdout, stderr: removeLineEndingWarnings(stderr), message: null };
    }
    catch (error) {
        const execError = error;
        const stderr = removeLineEndingWarnings(execError.stderr ?? '');
        return {
            ok: false,
            stdout: execError.stdout ?? '',
            stderr,
            message: stderr || removeLineEndingWarnings(execError.message ?? '') || 'Git command failed.',
        };
    }
}
export function toPosixPath(pathValue) {
    return pathValue.replace(/\\/g, '/');
}
export function toWindowsPath(pathValue) {
    const normalized = toPosixPath(pathValue);
    const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/);
    if (!wslMatch)
        return pathValue;
    const [, drive, rest] = wslMatch;
    return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
}
export function toFilesystemPath(pathValue) {
    return process.platform === 'win32' ? toWindowsPath(pathValue) : pathValue;
}
export function normalizeComparablePath(pathValue) {
    const normalized = toPosixPath(pathValue).replace(/\/+$/, '');
    const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/);
    const comparable = wslMatch
        ? `${wslMatch[1].toUpperCase()}:/${wslMatch[2]}`
        : normalized;
    return /^[A-Za-z]:/.test(comparable) ? comparable.toLowerCase() : comparable;
}
export function toAbsolutePath(repoRoot, relativePath) {
    return join(repoRoot, ...relativePath.split('/'));
}
export function getRelativeGitPath(repoRoot, filePath) {
    const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath);
    return toPosixPath(relative(repoRoot, absolutePath));
}
export function isInsideRepo(repoRoot, filePath) {
    const relativePath = relative(repoRoot, filePath);
    return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}
export async function pathExists(pathValue) {
    try {
        await stat(toFilesystemPath(pathValue));
        return true;
    }
    catch {
        return false;
    }
}
