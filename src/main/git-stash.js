import { runGitCommand } from './git-utils';
// `%gd` is the selector (`stash@{0}`), `%H` the stash commit hash, `%at` the
// author timestamp, `%gs` the reflog subject ("WIP on main: abc123 subject" /
// "On main: message"). NUL separators keep user-written stash messages
// unambiguous.
const STASH_LIST_FORMAT = '%gd%x00%H%x00%at%x00%gs';
function parseStashSubject(subject) {
    const match = subject.match(/^(?:WIP on|On) ([^:]+): (.*)$/);
    if (!match)
        return { branch: null, message: subject };
    return { branch: match[1], message: match[2] };
}
export async function listGitStashes(repoRoot) {
    const result = await runGitCommand(repoRoot, ['stash', 'list', `--format=${STASH_LIST_FORMAT}`]);
    const stashes = [];
    if (result.ok) {
        for (const line of result.stdout.split('\n')) {
            const [selector, hash, timestamp, subject] = line.split('\0');
            if (!selector || !hash || subject === undefined)
                continue;
            const indexMatch = selector.match(/^stash@\{(\d+)\}$/);
            if (!indexMatch)
                continue;
            const { branch, message } = parseStashSubject(subject);
            stashes.push({
                ref: selector,
                hash,
                index: Number.parseInt(indexMatch[1], 10),
                branch,
                message,
                createdAt: (Number.parseInt(timestamp ?? '', 10) || 0) * 1000,
            });
        }
    }
    return { repoRoot, stashes, updatedAt: Date.now() };
}
export async function pushGitStash(repoRoot, message, includeUntracked = true) {
    const statusResult = await runGitCommand(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!statusResult.ok)
        return statusResult;
    if (statusResult.stdout.length === 0) {
        return { ok: false, stdout: '', stderr: '', message: 'No local changes to stash.' };
    }
    const args = ['stash', 'push'];
    if (includeUntracked)
        args.push('--include-untracked');
    const trimmedMessage = message.trim();
    if (trimmedMessage)
        args.push('-m', trimmedMessage);
    return runGitCommand(repoRoot, args);
}
/**
 * Stash indexes are positional and shift whenever the stack changes (another
 * terminal pushing a stash renumbers every entry), so a mutation is only run
 * after re-checking that `stash@{index}` still points at the commit the UI
 * showed. Without this, a stale panel can pop or drop somebody else's stash.
 */
async function resolveStashSelector(repoRoot, index, expectedHash) {
    if (!Number.isInteger(index) || index < 0 || !expectedHash.trim()) {
        return { error: { ok: false, stdout: '', stderr: '', message: 'Choose a stash entry.' } };
    }
    const selector = `stash@{${index}}`;
    const resolved = await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', selector]);
    if (!resolved.ok || resolved.stdout.trim() !== expectedHash.trim()) {
        return {
            error: {
                ok: false,
                stdout: '',
                stderr: '',
                message: 'The stash list changed since it was loaded. It has been refreshed; try again.',
            },
        };
    }
    return { selector };
}
export async function applyGitStash(repoRoot, index, expectedHash, pop = false) {
    const resolved = await resolveStashSelector(repoRoot, index, expectedHash);
    if ('error' in resolved)
        return resolved.error;
    const result = await runGitCommand(repoRoot, ['stash', pop ? 'pop' : 'apply', resolved.selector]);
    if (!result.ok && pop && /conflict/i.test(`${result.stdout}\n${result.stderr}`)) {
        return {
            ...result,
            message: `${result.message ?? 'Git applied the stash with conflicts.'}\n\nThe changes were applied with conflicts, and Git kept the stash entry. Resolve the conflicts, then drop the entry — popping it again would re-apply the same changes.`,
        };
    }
    return result;
}
export async function dropGitStash(repoRoot, index, expectedHash) {
    const resolved = await resolveStashSelector(repoRoot, index, expectedHash);
    if ('error' in resolved)
        return resolved.error;
    return runGitCommand(repoRoot, ['stash', 'drop', resolved.selector]);
}
