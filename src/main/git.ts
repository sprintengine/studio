import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import { cloneTree } from './clone-tree'
import {
  getRelativeGitPath,
  isInsideRepo,
  normalizeComparablePath,
  pathExists,
  runGit,
  runGitCommand,
  toAbsolutePath,
  toFilesystemPath,
  toPosixPath,
} from './git-utils'
import { listGitWorktrees } from './git-worktree-list'
import { withWorktreeRegistryLock } from './worktree-registry-lock'
import {
  resolveRepoRoot,
  resolveWorktreeDestination,
  toWorktreeResult,
  validateBaseRef,
  validateBranchName,
} from './git-worktree-validation'

export { listGitWorktrees } from './git-worktree-list'
export { getGitStatus } from './git-status'
export { getGitBranches, getGitCommitGraph } from './git-read-models'
export { applyGitStash, dropGitStash, listGitStashes, pushGitStash } from './git-stash'
export { revertGitPaths, stageGitPaths, unstageGitPaths } from './git-file-actions'
export {
  abortGitOperation,
  checkoutGitCommit,
  checkoutGitCommitAsBranch,
  cherryPickGitCommit,
  commitGitChanges,
  continueGitOperation,
  createGitTagFromCommit,
  deleteGitBranch,
  fetchGitRemotes,
  mergeGitRef,
  pullGitBranchWithStash,
  pushGitBranch,
  rebaseGitBranch,
  renameGitBranch,
  resetGitBranchToCommit,
  revertGitCommit,
  switchGitBranch,
} from './git-branch-actions'

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'

export type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

/** A multi-step operation parked in the repo, awaiting continue or abort. */
export type GitRepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export type GitResetMode = 'soft' | 'mixed' | 'hard'

export type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  operation: GitRepoOperation | null
  updatedAt: number
}

export type GitStashEntry = {
  /** Git's selector for the entry, e.g. `stash@{0}`. */
  ref: string
  /** The stash commit hash — the entry's stable identity; selectors renumber. */
  hash: string
  index: number
  branch: string | null
  message: string
  createdAt: number
}

export type GitStashListSnapshot = {
  repoRoot: string
  stashes: GitStashEntry[]
  updatedAt: number
}

export type GitFileBaseResult = { ok: true; content: string } | { ok: false; message: string }

// Which stored version of a file to read for the diff viewer. `head` is the
// committed version (`git show HEAD:<p>`); `index` is the staged version
// (`git show :0:<p>`). Worktree content is read off disk via the fs IPC.
export type GitFileStage = 'head' | 'index'

export type GitFileStageResult =
  { ok: true; exists: boolean; content: string; binary: boolean; tooLarge: boolean } | { ok: false; message: string }

type GitBranch = {
  name: string
  current: boolean
  upstream: string | null
}

export type GitBranchSnapshot = {
  current: string | null
  branches: GitBranch[]
  ahead: number
  behind: number
}

type GitCommit = {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string[]
  subject: string
  commitWebUrl: string | null
}

export type GitGraphCommit = GitCommit & {
  parents: string[]
}

export type GitGraphSnapshot = {
  commits: GitGraphCommit[]
  refs: GitRef[]
  headHash: string | null
  detached: boolean
  totalCount: number
  hasMore: boolean
  updatedAt: number
}

export type GitGraphOptions = {
  limit?: number
  skip?: number
}

export type GitRef = {
  name: string
  hash: string
  type: 'head' | 'remote' | 'tag' | 'other'
}

export type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
  pushedCommitCount?: number
}

export type GitWorktreeEntry = {
  path: string
  head: string | null
  branch: string | null
  branchRef: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason: string | null
  prunable: boolean
  prunableReason: string | null
}

export type GitWorktreeListSnapshot = {
  repoRoot: string
  worktrees: GitWorktreeEntry[]
  updatedAt: number
}

type GitWorktreeCopyIncludedResult = {
  copied: string[]
  skipped: { path: string; reason: string }[]
}

export type GitWorktreeOperationResult<T> =
  | { ok: true; data: T; message: string | null; stdout?: string; stderr?: string }
  | { ok: false; message: string; stdout?: string; stderr?: string }

export type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
}

export type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}

export type GitConflictFileContent = {
  path: string
  relativePath: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
}

export async function getGitRepoRoot(folderPath: string): Promise<string | null> {
  try {
    const stdout = await runGit(folderPath, ['rev-parse', '--show-toplevel'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * The branch-already-exists refusal from `worktree add -b`, reworded to name
 * where that branch is checked out, which is what the person has to act on.
 * Null for any other failure, which keeps git's own words.
 */
async function explainBranchConflict(
  repoRoot: string,
  branch: string,
  addResult: GitCommandResult,
): Promise<string | null> {
  if (
    !/already exists|already checked out|already used by worktree/i.test(
      `${addResult.stderr}\n${addResult.message ?? ''}`,
    )
  ) {
    return null
  }
  const worktrees = await listGitWorktrees(repoRoot, { resolvedRoot: true })
  const holder = worktrees.ok ? worktrees.data.worktrees.find((worktree) => worktree.branch === branch) : undefined
  if (!holder) return null
  return `Branch "${branch}" is already checked out at ${holder.path}. Choose a different branch name or remove that worktree first.`
}

/**
 * Copy the repository's `.worktreeinclude` set into a worktree this module has
 * just created. `repoRoot` is already git's resolved root.
 */
export async function seedWorktreeIncludedFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<GitWorktreeOperationResult<GitWorktreeCopyIncludedResult>> {
  const includeFilePath = join(toFilesystemPath(repoRoot), '.worktreeinclude')
  const result: GitWorktreeCopyIncludedResult = {
    copied: [],
    skipped: [],
  }

  let includeFile = ''
  try {
    includeFile = await readFile(includeFilePath, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code && code !== 'ENOENT') {
      return {
        ok: false,
        message: `Unable to read .worktreeinclude: ${includeFilePath}`,
      }
    }

    return {
      ok: true,
      data: result,
      message: 'No .worktreeinclude file found.',
    }
  }

  const entries = includeFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  for (const entry of entries) {
    if (isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
      result.skipped.push({ path: entry, reason: 'Only repository-relative include paths are allowed.' })
      continue
    }

    if (/[*?[\]{}]/.test(entry)) {
      result.skipped.push({
        path: entry,
        reason: 'Glob patterns are not supported; list explicit files or directories.',
      })
      continue
    }

    const sourcePath = join(repoRoot, ...entry.split(/[\\/]+/))
    const destinationPath = join(worktreePath, ...entry.split(/[\\/]+/))

    if (
      !normalizeComparablePath(sourcePath).startsWith(`${normalizeComparablePath(repoRoot)}/`) ||
      !normalizeComparablePath(destinationPath).startsWith(`${normalizeComparablePath(worktreePath)}/`)
    ) {
      result.skipped.push({ path: entry, reason: 'Include path must stay inside the repository and target worktree.' })
      continue
    }

    if (!(await pathExists(sourcePath))) {
      result.skipped.push({ path: entry, reason: 'Source path does not exist.' })
      continue
    }

    try {
      const destinationFsPath = toFilesystemPath(destinationPath)
      await mkdir(dirname(destinationFsPath), { recursive: true })
      await cloneTree(toFilesystemPath(sourcePath), destinationFsPath)
      result.copied.push(entry)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.skipped.push({ path: entry, reason: message })
    }
  }

  return {
    ok: true,
    data: result,
    message: null,
  }
}

/**
 * Cut a new worktree on a new branch.
 *
 * Five git processes, in order, and no more: resolve the repository root once,
 * check the branch name and the base ref, `worktree add`, and one `worktree
 * list` to report the entry the way git spells it. Every one is a process start
 * on the launch path of a worktree agent, and on Windows or a network mount
 * each costs far more than the ~20 ms it costs here.
 *
 * There is no listing BEFORE the add to look for the branch being checked out
 * elsewhere: `worktree add -b` refuses an existing branch by itself, and only
 * that failure pays for a listing, to name the worktree that holds it.
 */
export async function createGitWorktree(
  input: GitWorktreeCreateInput,
): Promise<GitWorktreeOperationResult<GitWorktreeEntry>> {
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root

  const destination = resolveWorktreeDestination(input.containerPath, input.destinationPath)
  if (!destination.ok) return destination

  const branch = await validateBranchName(root.data, input.branchName)
  if (!branch.ok) return branch

  const baseRef = await validateBaseRef(root.data, input.baseRef)
  if (!baseRef.ok) return baseRef

  if (await pathExists(destination.data.destinationPath)) {
    return {
      ok: false,
      message: `Worktree destination already exists: ${destination.data.destinationPath}`,
    }
  }

  await mkdir(toFilesystemPath(destination.data.containerPath), { recursive: true })
  const addResult = await withWorktreeRegistryLock(root.data, () =>
    runGitCommand(root.data, ['worktree', 'add', '-b', branch.data, destination.data.destinationPath, baseRef.data]),
  )

  if (!addResult.ok) {
    return {
      ok: false,
      message:
        (await explainBranchConflict(root.data, branch.data, addResult)) ??
        addResult.message ??
        'Unable to create Git worktree.',
      stdout: addResult.stdout,
      stderr: addResult.stderr,
    }
  }

  if (input.copyIncludedFiles) {
    // Just created by the add above, so it is registered and on disk: the
    // seeding skips the checks it runs for a worktree someone else named.
    const copyResult = await seedWorktreeIncludedFiles(root.data, destination.data.destinationPath)
    if (!copyResult.ok) return copyResult
  }

  const nextWorktrees = await listGitWorktrees(root.data, { resolvedRoot: true })
  if (!nextWorktrees.ok) return nextWorktrees

  const createdWorktree = nextWorktrees.data.worktrees.find(
    (worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(destination.data.destinationPath),
  )

  if (!createdWorktree) {
    return {
      ok: false,
      message: `Git created the worktree, but it was not reported by "git worktree list": ${destination.data.destinationPath}`,
      stdout: addResult.stdout,
      stderr: addResult.stderr,
    }
  }

  return {
    ok: true,
    data: createdWorktree,
    message: null,
    stdout: addResult.stdout,
    stderr: addResult.stderr,
  }
}

export async function removeGitWorktree(
  input: GitWorktreeRemoveInput,
): Promise<GitWorktreeOperationResult<GitCommandResult>> {
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root

  const worktreePath = input.path
  const worktrees = await listGitWorktrees(root.data, { resolvedRoot: true })
  if (!worktrees.ok) return worktrees

  const registeredWorktree = worktrees.data.worktrees.find(
    (worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(worktreePath),
  )
  if (!registeredWorktree) {
    return {
      ok: false,
      message: `Worktree is not registered for this repository: ${worktreePath}`,
    }
  }

  if (!(await pathExists(worktreePath))) {
    return {
      ok: false,
      message: `Worktree path is missing: ${worktreePath}. Run worktree prune to clean up stale Git metadata.`,
    }
  }

  if (!input.force) {
    const statusResult = await runGitCommand(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!statusResult.ok) {
      return {
        ok: false,
        message: statusResult.message ?? 'Unable to check whether the worktree is clean.',
        stdout: statusResult.stdout,
        stderr: statusResult.stderr,
      }
    }

    if (statusResult.stdout.length > 0) {
      return {
        ok: false,
        message: `Worktree has uncommitted changes: ${worktreePath}. Commit, stash, discard changes, or retry with force.`,
        stdout: statusResult.stdout,
        stderr: statusResult.stderr,
      }
    }
  }

  const removeResult = await withWorktreeRegistryLock(root.data, () =>
    runGitCommand(root.data, ['worktree', 'remove', ...(input.force ? ['--force'] : []), worktreePath]),
  )

  return toWorktreeResult(removeResult, removeResult)
}

export async function pruneGitWorktrees(repoRoot: string): Promise<GitWorktreeOperationResult<GitCommandResult>> {
  const root = await resolveRepoRoot(repoRoot)
  if (!root.ok) return root

  const result = await withWorktreeRegistryLock(root.data, () => runGitCommand(root.data, ['worktree', 'prune']))
  return toWorktreeResult(result, result)
}

export async function getGitFileBase(repoRoot: string, filePath: string): Promise<GitFileBaseResult> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath)
  if (!isInsideRepo(repoRoot, absolutePath) && dirname(absolutePath) !== repoRoot) {
    return { ok: false, message: 'File is outside the Git repository.' }
  }

  try {
    const relativePath = getRelativeGitPath(repoRoot, absolutePath)
    const content = await runGit(repoRoot, ['show', `HEAD:${relativePath}`])
    return { ok: true, content }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  }
}

// Read the file 5 MiB cap mirrors the renderer's editor read limit: past this
// the diff viewer degrades to a clear "too large" message rather than hanging.
const GIT_FILE_STAGE_MAX_BYTES = 5 * 1024 * 1024

// Returns the file's stored content at a given Git stage for the diff viewer.
// A missing object (new file has no HEAD/index entry; a deleted file has no
// index entry) is not an error here — it resolves to `exists: false` with empty
// content so the viewer can render an empty pane. Binary and oversized objects
// are reported via flags instead of returning their bytes as text.
export async function getGitFileAtStage(
  repoRoot: string,
  filePath: string,
  stage: GitFileStage,
): Promise<GitFileStageResult> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath)
  if (!isInsideRepo(repoRoot, absolutePath) && dirname(absolutePath) !== repoRoot) {
    return { ok: false, message: 'File is outside the Git repository.' }
  }

  const relativePath = getRelativeGitPath(repoRoot, absolutePath)
  const ref = stage === 'head' ? `HEAD:${relativePath}` : `:0:${relativePath}`

  // `cat-file -s` resolves both existence and size in one cheap call: it fails
  // when the object is absent at this stage, and prints the byte size when present.
  const sizeResult = await runGitCommand(repoRoot, ['cat-file', '-s', ref])
  if (!sizeResult.ok) {
    return { ok: true, exists: false, content: '', binary: false, tooLarge: false }
  }
  const size = Number.parseInt(sizeResult.stdout.trim(), 10)
  if (Number.isFinite(size) && size > GIT_FILE_STAGE_MAX_BYTES) {
    return { ok: true, exists: true, content: '', binary: false, tooLarge: true }
  }

  try {
    const content = await runGit(repoRoot, ['show', ref])
    const binary = content.includes('\u0000')
    return { ok: true, exists: true, content: binary ? '' : content, binary, tooLarge: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  }
}

function normalizeConflictFilePath(
  repoRoot: string,
  filePath: string,
): { absolutePath: string; relativePath: string } | null {
  const absolutePath = isAbsolute(filePath) ? filePath : toAbsolutePath(repoRoot, toPosixPath(filePath))
  if (!isInsideRepo(repoRoot, absolutePath) && dirname(absolutePath) !== repoRoot) return null

  return {
    absolutePath,
    relativePath: getRelativeGitPath(repoRoot, absolutePath),
  }
}

async function getGitConflictStage(repoRoot: string, stage: 1 | 2 | 3, relativePath: string): Promise<string | null> {
  const result = await runGitCommand(repoRoot, ['show', `:${stage}:${relativePath}`])
  return result.ok ? result.stdout : null
}

export async function getGitConflictFile(repoRoot: string, filePath: string): Promise<GitConflictFileContent | null> {
  const normalized = normalizeConflictFilePath(repoRoot, filePath)
  if (!normalized) return null

  const [base, ours, theirs] = await Promise.all([
    getGitConflictStage(repoRoot, 1, normalized.relativePath),
    getGitConflictStage(repoRoot, 2, normalized.relativePath),
    getGitConflictStage(repoRoot, 3, normalized.relativePath),
  ])

  let result = ''
  try {
    result = await readFile(toFilesystemPath(normalized.absolutePath), 'utf8')
  } catch {
    result = ''
  }

  return {
    path: normalized.absolutePath,
    relativePath: normalized.relativePath,
    base,
    ours,
    theirs,
    result,
  }
}

export async function resolveGitConflict(
  repoRoot: string,
  filePath: string,
  content: string,
): Promise<GitCommandResult> {
  const normalized = normalizeConflictFilePath(repoRoot, filePath)
  if (!normalized) {
    return { ok: false, stdout: '', stderr: '', message: 'File is outside the Git repository.' }
  }

  await writeFile(toFilesystemPath(normalized.absolutePath), content, 'utf8')
  return runGitCommand(repoRoot, ['add', '--', normalized.relativePath])
}

// The two managed MCP-config files a per-spawn sync writes into a worktree root:
// Claude's `.mcp.json` and Codex's `.codex/config.toml`. Excluded from a
// connector worktree's git so the generated, machine-specific config never shows
// up in the connector chat's `git status` or commits.
export const MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES = ['.mcp.json', '.codex/config.toml'] as const

/**
 * Append each of {@link entries} to a worktree's git exclude file so those paths
 * are never staged. The exclude path is resolved via
 * `git rev-parse --git-path info/exclude` — for a linked worktree git reads the
 * shared common-dir exclude, not a per-worktree one, so resolving it is the only
 * reliable way to land the entries where git will honor them. Idempotent per
 * entry: an already-present line is not duplicated. Throws if git or the write
 * fails.
 */
async function appendWorktreeGitExcludes(worktreePath: string, entries: readonly string[]): Promise<void> {
  const resolved = await runGitCommand(worktreePath, ['rev-parse', '--git-path', 'info/exclude'])
  if (!resolved.ok) {
    throw new Error(resolved.message ?? 'git rev-parse --git-path info/exclude failed.')
  }
  const rawPath = resolved.stdout.trim()
  if (!rawPath) throw new Error('git returned an empty exclude path.')
  const excludePath = isAbsolute(rawPath) ? rawPath : resolve(worktreePath, rawPath)

  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch {
    // No exclude file yet; appendFile creates it below.
  }
  const present = new Set(existing.split('\n').map((line) => line.trim()))
  const missing = entries.filter((entry) => !present.has(entry))
  if (missing.length === 0) return

  await mkdir(dirname(excludePath), { recursive: true })
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  await appendFile(excludePath, `${separator}${missing.join('\n')}\n`, 'utf8')
}

/**
 * Keep the generated managed MCP config ({@link MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES})
 * out of a connector worktree's git. Best-effort at the call site: the caller
 * swallows failures so a launch is never blocked by an exclude write.
 */
export async function excludeMcpConfigFromWorktree(worktreePath: string): Promise<void> {
  await appendWorktreeGitExcludes(worktreePath, MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES)
}
