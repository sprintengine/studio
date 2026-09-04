import { pathExists, runGitCommand } from './git-utils'

/**
 * What a checkout's current branch has produced — the reading the sidebar row
 * and the changed-files surface both stand on
 * (the-diff-an-agent-made / branch-scoped-row-diff).
 *
 * The span is `merge-base(HEAD, <default branch>) → working tree`: every commit
 * this branch carries that the default branch does not, plus whatever is still
 * uncommitted. Measuring from the merge-base is the whole point — a pull, a
 * merge from the default branch, or a commit landing under the agent moves HEAD
 * *and* the base together, so ordinary repo movement cannot inflate the number.
 * That is the failure that retired the checkpoint model (epic Direction change),
 * and this shape cannot have it.
 *
 * Everything here is quiet: git runs through `runGitCommand`, which returns
 * failures as values, and every entry point degrades to a null or empty result
 * rather than throwing into main.
 */

export type BranchFileStat = {
  path: string
  additions: number
  deletions: number
}

export type BranchSpanStat = {
  additions: number
  deletions: number
  changedFiles: number
  files: BranchFileStat[]
}

export type BranchSpan = {
  /** Branch name, or null on a detached HEAD or an unreadable repo. */
  branch: string | null
  /**
   * The commit the span measures from. `null` means no base resolved — a
   * detached HEAD, an unborn repo, or a repo with no default branch to compare
   * against — and the span is then simply `HEAD → working tree`.
   */
  baseOid: string | null
  /** True when this cwd is a LINKED worktree, so nothing else writes into it. */
  isLinkedWorktree: boolean
  /** True when HEAD carries commits the base does not. */
  aheadOfBase: boolean
  stat: BranchSpanStat
}

/**
 * A fresh empty result each time. Never a shared constant: it is handed to
 * callers, and one that sorted `files` in place would corrupt every later
 * failure result for the life of the process.
 */
export function emptyBranchSpanStat(): BranchSpanStat {
  return { additions: 0, deletions: 0, changedFiles: 0, files: [] }
}

/**
 * Candidate default branches, best first. `origin/HEAD` is the only one that
 * actually *knows* the remote's default; the rest are the conventional guesses
 * a repo without it will still answer to, and `@{upstream}` covers a branch
 * tracking something other than the default.
 */
async function defaultBaseCandidates(cwd: string): Promise<string[]> {
  const candidates: string[] = []
  // `symbolic-ref` on the remote HEAD ref: present after a clone, absent after
  // `git init` + `remote add`, which is why it is a candidate and not a
  // requirement.
  const originHead = await runGitCommand(cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (originHead.ok) {
    const value = originHead.stdout.trim()
    if (value) candidates.push(value)
  }
  candidates.push('origin/main', 'origin/master', '@{upstream}', 'main', 'master')
  return candidates
}

async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  const result = await runGitCommand(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  if (!result.ok) return null
  const oid = result.stdout.trim()
  return oid.length > 0 ? oid : null
}

/**
 * The merge-base between HEAD and the first default-branch candidate that
 * resolves, or null when none does.
 *
 * Deliberately NOT called on a detached HEAD: a detached checkout has no branch
 * whose work could be attributed, and merge-basing it against `origin/main`
 * would report the whole of history since the detach point as the agent's.
 */
export async function resolveBranchBase(cwd: string): Promise<string | null> {
  for (const candidate of await defaultBaseCandidates(cwd)) {
    if ((await resolveCommit(cwd, candidate)) === null) continue
    const base = await runGitCommand(cwd, ['merge-base', 'HEAD', candidate])
    if (!base.ok) continue
    const oid = base.stdout.trim()
    if (oid) return oid
  }
  return null
}

/**
 * Whether `cwd` is a LINKED worktree rather than a repo's main working tree.
 *
 * `--git-dir` points at `<common>/worktrees/<name>` for a linked worktree and
 * at `<common>` for the main one, so the two answers differing IS the test.
 * Both are resolved to absolute paths first: git answers `--git-dir` relatively
 * (`.git`) from a repo root, and comparing `.git` against an absolute common
 * dir would call every main checkout a worktree.
 */
export async function isLinkedWorktree(cwd: string): Promise<boolean> {
  const [gitDir, commonDir] = await Promise.all([
    runGitCommand(cwd, ['rev-parse', '--absolute-git-dir']),
    runGitCommand(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ])
  if (!gitDir.ok || !commonDir.ok) return false
  const own = gitDir.stdout.trim()
  const common = commonDir.stdout.trim()
  if (!own || !common) return false
  return own !== common
}

/**
 * The branch name, or null on a detached HEAD / unreadable repo.
 *
 * `symbolic-ref` rather than `rev-parse --abbrev-ref`: it names the branch even
 * on an unborn HEAD and fails on a detached checkout, which is exactly the
 * distinction the row needs.
 */
export async function readBranchName(cwd: string): Promise<string | null> {
  const result = await runGitCommand(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!result.ok) return null
  return result.stdout.trim() || null
}

/**
 * Read the whole span for a checkout, or null when the path is gone or is not a
 * git repository. Null is "no facts", which a caller renders as nothing; it is
 * never an error.
 */
export async function readBranchSpan(cwd: string): Promise<BranchSpan | null> {
  if (!(await pathExists(cwd))) return null
  const inRepo = await runGitCommand(cwd, ['rev-parse', '--git-dir'])
  if (!inRepo.ok) return null

  const branch = await readBranchName(cwd)
  const headOid = await resolveCommit(cwd, 'HEAD')

  // An unborn HEAD (fresh `git init`) has a branch name but no commit, so there
  // is nothing to diff against and nothing committed to be ahead of.
  if (headOid === null) {
    return {
      branch,
      baseOid: null,
      isLinkedWorktree: await isLinkedWorktree(cwd),
      aheadOfBase: false,
      stat: emptyBranchSpanStat(),
    }
  }

  const baseOid = branch === null ? null : await resolveBranchBase(cwd)
  const [isWorktree, stat] = await Promise.all([
    isLinkedWorktree(cwd),
    diffWorkingTreeFrom(cwd, baseOid ?? headOid),
  ])

  return {
    branch,
    baseOid,
    isLinkedWorktree: isWorktree,
    // Equality is the honest test for "has this branch committed anything the
    // base does not". A base that IS HEAD means the branch is level with the
    // default branch and only its uncommitted state can be reported.
    aheadOfBase: baseOid !== null && baseOid !== headOid,
    stat,
  }
}

/**
 * `git diff --numstat <from>` — staged and unstaged, against the working tree.
 *
 * Untracked files are invisible to `diff`, exactly as they are to the row's
 * previous reading and to the chrome's git badge: a file git has never tracked
 * has no line counts to report. The changed-files surface lists them
 * separately; a row that summarises edits does not.
 */
export async function diffWorkingTreeFrom(cwd: string, fromRev: string): Promise<BranchSpanStat> {
  const result = await runGitCommand(cwd, [
    'diff',
    '--numstat',
    '-z',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    fromRev,
  ])
  if (!result.ok) return emptyBranchSpanStat()
  return parseNumstatZ(result.stdout)
}

/**
 * Parses `git diff --numstat -z` output.
 *
 * Exported for its own test: in `-z`, a rename or copy emits THREE
 * NUL-terminated fields — stats, old path, new path — while an ordinary change
 * emits stats and path together in one. Mis-framing that silently drops or
 * misattributes every file after the first rename.
 *
 * A binary file's counts are `-` in both columns; it is reported as a changed
 * file contributing zero lines, which is what it is.
 */
export function parseNumstatZ(stdout: string): BranchSpanStat {
  const fields = stdout.split('\0')
  const files: BranchFileStat[] = []
  let additions = 0
  let deletions = 0

  let index = 0
  while (index < fields.length) {
    const record = fields[index]
    if (!record) {
      index += 1
      continue
    }
    const parts = record.split('\t')
    if (parts.length < 2) {
      index += 1
      continue
    }
    const addsField = parts[0]
    const delsField = parts[1]
    // A plain change carries its path inline as the third tab-separated part.
    // A rename ends the record after the trailing tab and follows it with the
    // old and new paths as two more NUL-terminated fields.
    let path = parts.slice(2).join('\t')
    if (path === '') {
      const newPath = fields[index + 2]
      path = newPath ?? ''
      index += 3
    } else {
      index += 1
    }
    if (!path) continue
    const adds = addsField === '-' ? 0 : Number.parseInt(addsField, 10)
    const dels = delsField === '-' ? 0 : Number.parseInt(delsField, 10)
    const safeAdds = Number.isFinite(adds) ? adds : 0
    const safeDels = Number.isFinite(dels) ? dels : 0
    additions += safeAdds
    deletions += safeDels
    files.push({ path, additions: safeAdds, deletions: safeDels })
  }

  return { additions, deletions, changedFiles: files.length, files }
}
