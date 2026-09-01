import { isAbsolute, resolve } from 'path';
import { pathExists, runGit, toAbsolutePath } from './git-utils';
function isConflictStatus({ index, worktree }) {
    return index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D');
}
function toFileStatus(code) {
    if (code.index === '?' && code.worktree === '?')
        return 'new';
    if (isConflictStatus(code))
        return 'conflicted';
    if (code.index === 'R' || code.worktree === 'R')
        return 'renamed';
    if (code.index === 'A' || code.worktree === 'A')
        return 'new';
    if (code.index === 'D' || code.worktree === 'D')
        return 'deleted';
    return 'modified';
}
function parseStatusEntry(repoRoot, code, relativePath) {
    return {
        path: toAbsolutePath(repoRoot, relativePath),
        relativePath,
        status: toFileStatus(code),
        staged: code.index !== ' ' && code.index !== '?',
        unstaged: code.index === '?' || code.worktree !== ' ',
    };
}
// Marker paths that flag a multi-step operation parked in the repo, in
// precedence order: a conflicted rebase can leave merge-ish files around, so
// the rebase directories are checked first. Editors' git integrations classify
// the same way (stat the markers, don't parse porcelain). `rebase-apply` is
// also created by a parked `git am` — git distinguishes the two by the
// `applying` file inside it, and an am session is not ours to continue/abort,
// so it must report no operation.
const OPERATION_MARKERS = [
    { operation: 'rebase', marker: 'rebase-merge' },
    { operation: 'rebase', marker: 'rebase-apply', notMarker: 'rebase-apply/applying' },
    { operation: 'cherry-pick', marker: 'CHERRY_PICK_HEAD' },
    { operation: 'revert', marker: 'REVERT_HEAD' },
    { operation: 'merge', marker: 'MERGE_HEAD' },
];
// getGitStatus is the watch-driven hot path, so the `--git-path` resolution
// (one git spawn) runs once per repo root; the resolved marker paths are
// stable for a checkout's lifetime.
const markerPathsCache = new Map();
async function resolveOperationMarkerPaths(repoRoot) {
    const cached = markerPathsCache.get(repoRoot);
    if (cached)
        return cached;
    // `--git-path` resolves per-worktree paths (`.git` may be a file pointing at
    // the shared git dir), one output line per flag in argument order.
    const markers = OPERATION_MARKERS.flatMap(({ marker, notMarker }) => notMarker ? [marker, notMarker] : [marker]);
    const stdout = await runGit(repoRoot, ['rev-parse', ...markers.flatMap((marker) => ['--git-path', marker])]);
    const paths = stdout
        .split('\n')
        .slice(0, markers.length)
        .map((line) => (isAbsolute(line.trim()) ? line.trim() : resolve(repoRoot, line.trim())));
    markerPathsCache.set(repoRoot, paths);
    return paths;
}
/** Which merge/rebase/cherry-pick/revert operation is parked in the repo, if any. */
export async function getGitOperationInProgress(repoRoot) {
    try {
        const paths = await resolveOperationMarkerPaths(repoRoot);
        const exists = await Promise.all(paths.map((markerPath) => pathExists(markerPath)));
        let pathIndex = 0;
        for (const { operation, notMarker } of OPERATION_MARKERS) {
            const markerHit = exists[pathIndex];
            const notMarkerHit = notMarker ? exists[pathIndex + 1] : false;
            pathIndex += notMarker ? 2 : 1;
            if (markerHit && !notMarkerHit)
                return operation;
            if (markerHit && notMarkerHit)
                return null;
        }
    }
    catch {
        // A repo we cannot inspect reports no operation rather than failing status.
    }
    return null;
}
export async function getGitStatus(repoRoot) {
    const [stdout, operation] = await Promise.all([
        runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        getGitOperationInProgress(repoRoot),
    ]);
    const records = stdout.split('\0').filter(Boolean);
    const files = {};
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.length < 4)
            continue;
        const code = { index: record[0] ?? ' ', worktree: record[1] ?? ' ' };
        const relativePath = record.slice(3);
        const entry = parseStatusEntry(repoRoot, code, relativePath);
        files[entry.path] = entry;
        if (code.index === 'R' || code.worktree === 'R') {
            const originalPath = records[index + 1];
            if (originalPath) {
                const deletedEntry = parseStatusEntry(repoRoot, { index: 'D', worktree: ' ' }, originalPath);
                files[deletedEntry.path] = deletedEntry;
                index += 1;
            }
        }
    }
    return {
        repoRoot,
        files,
        operation,
        updatedAt: Date.now(),
    };
}
