import { getGitBranches } from './git-read-models';
import { runGitCommand } from './git-utils';
// Continue/finish steps invoke git's commit-message editor by default; a hung
// hidden editor reads as "nothing happened", so every such command runs with
// the editor disabled and git's prepared message kept as-is. This must be the
// GIT_EDITOR env var — it outranks an inherited GIT_EDITOR from the launching
// shell, which a `-c core.editor` flag does not.
const NO_EDITOR_ENV = { GIT_EDITOR: 'true' };
function fail(message) {
    return { ok: false, stdout: '', stderr: '', message };
}
/**
 * Shared precondition for history-mutating operations: a named branch checked
 * out (`verb` fills the refusal, e.g. "merge") and — unless `allowDirty` — no
 * uncommitted tracked changes (`dirtyPhrase` fills that refusal, e.g.
 * "before merging").
 */
async function requireCleanCurrentBranch(repoRoot, verb, dirtyPhrase) {
    const branch = await getCurrentBranchName(repoRoot);
    if (!branch) {
        return { branch: null, error: fail(`Cannot ${verb} while HEAD is detached. Check out a branch first.`) };
    }
    if (dirtyPhrase && (await hasUncommittedTrackedChanges(repoRoot))) {
        return { branch: null, error: fail(`Commit, stash, or discard your tracked changes ${dirtyPhrase}.`) };
    }
    return { branch, error: null };
}
/** Resolves a user-chosen ref/hash to a commit, or a "cannot find" refusal. */
async function resolveTargetCommit(repoRoot, target) {
    const resolved = await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
    if (resolved.ok)
        return null;
    return {
        ok: false,
        stdout: resolved.stdout,
        stderr: resolved.stderr,
        message: `Cannot find branch or commit "${target}".`,
    };
}
export async function commitGitChanges(repoRoot, message) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
        return { ok: false, stdout: '', stderr: '', message: 'Enter a commit message.' };
    }
    return runGitCommand(repoRoot, ['commit', '-m', trimmedMessage]);
}
export async function pushGitBranch(repoRoot) {
    const branchSnapshot = await getGitBranches(repoRoot);
    const currentBranch = branchSnapshot.current;
    if (!currentBranch) {
        return {
            ok: false,
            stdout: '',
            stderr: '',
            message: 'Cannot push while HEAD is detached. Check out a branch first.',
        };
    }
    const branch = branchSnapshot.branches.find((candidate) => candidate.current);
    if (branch?.upstream) {
        const pushedCommitCount = await countCommitsToPush(repoRoot, branch.upstream);
        const result = await runGitCommand(repoRoot, ['push']);
        return result.ok ? { ...result, pushedCommitCount } : result;
    }
    return {
        ok: false,
        stdout: '',
        stderr: '',
        message: `Branch "${currentBranch}" has no upstream. Set an upstream branch first, for example: git push --set-upstream origin ${currentBranch}`,
    };
}
async function countCommitsToPush(repoRoot, upstream) {
    const result = await runGitCommand(repoRoot, ['rev-list', '--count', `${upstream}..HEAD`]);
    if (!result.ok)
        return 0;
    return Number.parseInt(result.stdout.trim(), 10) || 0;
}
export async function fetchGitRemotes(repoRoot) {
    return runGitCommand(repoRoot, ['fetch', '--prune']);
}
function appendGitCommandOutput(parts, label, result) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    if (output)
        parts.push(`${label}:\n${output}`);
}
export async function pullGitBranchWithStash(repoRoot) {
    const statusResult = await runGitCommand(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!statusResult.ok)
        return statusResult;
    const hasLocalChanges = statusResult.stdout.length > 0;
    const outputs = [];
    let stashCreated = false;
    if (hasLocalChanges) {
        const stashResult = await runGitCommand(repoRoot, [
            'stash',
            'push',
            '--include-untracked',
            '-m',
            'Multicode auto-stash before pull',
        ]);
        appendGitCommandOutput(outputs, 'stash', stashResult);
        if (!stashResult.ok)
            return stashResult;
        stashCreated = !/No local changes to save/i.test(`${stashResult.stdout}\n${stashResult.stderr}`);
    }
    const pullResult = await runGitCommand(repoRoot, ['pull', '--no-rebase', '--ff', '--no-edit']);
    appendGitCommandOutput(outputs, 'pull', pullResult);
    if (!pullResult.ok) {
        return {
            ...pullResult,
            stdout: outputs.join('\n\n'),
            message: stashCreated
                ? `${pullResult.message ?? 'Git pull failed.'}\n\nYour local changes were saved in the Git stash and were not reapplied because pull did not finish cleanly.`
                : pullResult.message,
        };
    }
    if (!stashCreated) {
        return {
            ...pullResult,
            stdout: outputs.join('\n\n') || pullResult.stdout,
        };
    }
    const popResult = await runGitCommand(repoRoot, ['stash', 'pop']);
    appendGitCommandOutput(outputs, 'stash pop', popResult);
    if (!popResult.ok) {
        return {
            ...popResult,
            stdout: outputs.join('\n\n'),
            message: `${popResult.message ?? 'Git reapplied the stash with conflicts.'}\n\nPull completed, but reapplying your stashed changes did not finish cleanly. Resolve conflicts in the working tree; Git keeps the stash entry when pop conflicts.`,
        };
    }
    return {
        ...popResult,
        stdout: outputs.join('\n\n'),
        message: null,
    };
}
export async function switchGitBranch(repoRoot, branchName) {
    const trimmedBranch = branchName.trim();
    if (!trimmedBranch) {
        return { ok: false, stdout: '', stderr: '', message: 'Choose a branch.' };
    }
    return runGitCommand(repoRoot, ['switch', trimmedBranch]);
}
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
function invalidCommit() {
    return { ok: false, stdout: '', stderr: '', message: 'Invalid commit hash.' };
}
function validateRefName(name, kind) {
    const trimmed = name.trim();
    if (!trimmed)
        return { ok: false, stdout: '', stderr: '', message: `Enter a ${kind} name.` };
    if (trimmed.startsWith('-')) {
        return { ok: false, stdout: '', stderr: '', message: `${kind === 'branch' ? 'Branch' : 'Tag'} names cannot start with a dash.` };
    }
    return null;
}
function validateMergeTarget(ref) {
    const trimmed = ref.trim();
    if (!trimmed)
        return { ok: false, stdout: '', stderr: '', message: 'Choose a branch or commit to merge.' };
    if (trimmed.startsWith('-')) {
        return { ok: false, stdout: '', stderr: '', message: 'Merge targets cannot start with a dash.' };
    }
    return null;
}
/** Tracked, uncommitted modifications block a detaching checkout to avoid silent carry-over. */
async function hasUncommittedTrackedChanges(repoRoot) {
    const result = await runGitCommand(repoRoot, ['status', '--porcelain=v1', '--untracked-files=no']);
    return result.ok && result.stdout.trim().length > 0;
}
async function getCurrentBranchName(repoRoot) {
    const result = await runGitCommand(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (!result.ok)
        return null;
    return result.stdout.trim() || null;
}
export async function mergeGitRef(repoRoot, ref) {
    const target = ref.trim();
    const invalid = validateMergeTarget(target);
    if (invalid)
        return invalid;
    const guard = await requireCleanCurrentBranch(repoRoot, 'merge', 'before merging');
    if (guard.error)
        return guard.error;
    if (target === guard.branch || target === `refs/heads/${guard.branch}`) {
        return fail('Choose a different branch or commit to merge.');
    }
    const unresolved = await resolveTargetCommit(repoRoot, target);
    if (unresolved)
        return unresolved;
    return runGitCommand(repoRoot, ['merge', '--no-edit', target]);
}
export async function rebaseGitBranch(repoRoot, ontoRef) {
    const target = ontoRef.trim();
    const invalid = validateMergeTarget(target);
    if (invalid)
        return invalid;
    const guard = await requireCleanCurrentBranch(repoRoot, 'rebase', 'before rebasing');
    if (guard.error)
        return guard.error;
    if (target === guard.branch || target === `refs/heads/${guard.branch}`) {
        return fail('Choose a different branch or commit to rebase onto.');
    }
    const unresolved = await resolveTargetCommit(repoRoot, target);
    if (unresolved)
        return unresolved;
    return runGitCommand(repoRoot, ['rebase', target], NO_EDITOR_ENV);
}
async function isMergeCommit(repoRoot, hash) {
    const secondParent = await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', `${hash}^2`]);
    return secondParent.ok;
}
export async function cherryPickGitCommit(repoRoot, commitHash) {
    const hash = commitHash.trim();
    if (!COMMIT_HASH_PATTERN.test(hash))
        return invalidCommit();
    const guard = await requireCleanCurrentBranch(repoRoot, 'cherry-pick', 'before cherry-picking');
    if (guard.error)
        return guard.error;
    if (await isMergeCommit(repoRoot, hash)) {
        return fail('This is a merge commit; cherry-picking it needs a mainline parent (git cherry-pick -m). Use the Git terminal.');
    }
    return runGitCommand(repoRoot, ['cherry-pick', hash], NO_EDITOR_ENV);
}
export async function revertGitCommit(repoRoot, commitHash) {
    const hash = commitHash.trim();
    if (!COMMIT_HASH_PATTERN.test(hash))
        return invalidCommit();
    const guard = await requireCleanCurrentBranch(repoRoot, 'revert', 'before reverting a commit');
    if (guard.error)
        return guard.error;
    if (await isMergeCommit(repoRoot, hash)) {
        return fail('This is a merge commit; reverting it needs a mainline parent (git revert -m). Use the Git terminal.');
    }
    return runGitCommand(repoRoot, ['revert', '--no-edit', hash], NO_EDITOR_ENV);
}
const GIT_RESET_MODES = ['soft', 'mixed', 'hard'];
export async function resetGitBranchToCommit(repoRoot, commitHash, mode) {
    const hash = commitHash.trim();
    if (!COMMIT_HASH_PATTERN.test(hash))
        return invalidCommit();
    if (!GIT_RESET_MODES.includes(mode)) {
        return fail('Choose a reset mode: soft, mixed, or hard.');
    }
    // Moving uncommitted changes around is the point of soft/mixed, so only the
    // branch guard applies here — no clean-tree requirement.
    const guard = await requireCleanCurrentBranch(repoRoot, 'reset', null);
    if (guard.error)
        return guard.error;
    return runGitCommand(repoRoot, ['reset', `--${mode}`, hash]);
}
export async function deleteGitBranch(repoRoot, branchName, force = false) {
    const invalid = validateRefName(branchName, 'branch');
    if (invalid)
        return invalid;
    const name = branchName.trim();
    const currentBranch = await getCurrentBranchName(repoRoot);
    if (currentBranch && name === currentBranch) {
        return fail('Cannot delete the branch you are on. Switch to another branch first.');
    }
    return runGitCommand(repoRoot, ['branch', force ? '-D' : '-d', name]);
}
export async function renameGitBranch(repoRoot, branchName, newName) {
    const invalidOld = validateRefName(branchName, 'branch');
    if (invalidOld)
        return invalidOld;
    const invalidNew = validateRefName(newName, 'branch');
    if (invalidNew)
        return invalidNew;
    return runGitCommand(repoRoot, ['branch', '-m', branchName.trim(), newName.trim()]);
}
// The operation name doubles as the git subcommand, but IPC input is
// untrusted, so validate against the closed set before shelling out.
const GIT_OPERATIONS = ['merge', 'rebase', 'cherry-pick', 'revert'];
export async function continueGitOperation(repoRoot, operation) {
    if (!GIT_OPERATIONS.includes(operation)) {
        return fail('No continuable Git operation in progress.');
    }
    return runGitCommand(repoRoot, [operation, '--continue'], NO_EDITOR_ENV);
}
export async function abortGitOperation(repoRoot, operation) {
    if (!GIT_OPERATIONS.includes(operation)) {
        return fail('No abortable Git operation in progress.');
    }
    return runGitCommand(repoRoot, [operation, '--abort']);
}
export async function checkoutGitCommit(repoRoot, commitHash) {
    const hash = commitHash.trim();
    if (!COMMIT_HASH_PATTERN.test(hash))
        return invalidCommit();
    if (await hasUncommittedTrackedChanges(repoRoot)) {
        return {
            ok: false,
            stdout: '',
            stderr: '',
            message: 'Commit, stash, or discard your tracked changes before checking out a commit.',
        };
    }
    return runGitCommand(repoRoot, ['checkout', hash]);
}
export async function createGitBranchFromCommit(repoRoot, branchName, commitHash) {
    const hash = commitHash.trim();
    if (!COMMIT_HASH_PATTERN.test(hash))
        return invalidCommit();
    const invalid = validateRefName(branchName, 'branch');
    if (invalid)
        return invalid;
    return runGitCommand(repoRoot, ['branch', branchName.trim(), hash]);
}
export async function checkoutGitCommitAsBranch(repoRoot, branchName, commitHash) {
    const hash = commitHash.trim();
    if (!COMMIT_HASH_PATTERN.test(hash))
        return invalidCommit();
    const invalid = validateRefName(branchName, 'branch');
    if (invalid)
        return invalid;
    if (await hasUncommittedTrackedChanges(repoRoot)) {
        return {
            ok: false,
            stdout: '',
            stderr: '',
            message: 'Commit, stash, or discard your tracked changes before creating a branch here.',
        };
    }
    return runGitCommand(repoRoot, ['checkout', '-b', branchName.trim(), hash]);
}
export async function createGitTagFromCommit(repoRoot, tagName, commitHash) {
    const hash = commitHash.trim();
    if (!COMMIT_HASH_PATTERN.test(hash))
        return invalidCommit();
    const invalid = validateRefName(tagName, 'tag');
    if (invalid)
        return invalid;
    return runGitCommand(repoRoot, ['tag', tagName.trim(), hash]);
}
