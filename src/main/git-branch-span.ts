import { isAbsolute, resolve } from 'path'

import { pathExists, runGitCommand } from './git-utils'

/**
 * What a checkout's current branch has produced — the reading the sidebar row
 * and the changed-files surface both stand on
 * (the-diff-an-agent-made / branch-scoped-row-diff).
 *
 * The span is `merge-base(HEAD, <trunk>) → working tree`: every commit this
 * branch carries that the trunk does not, plus whatever is still uncommitted.
 * Measuring from the merge-base is the whole point — a pull, a merge from the
 * trunk, or a commit landing under the agent moves HEAD *and* the base together,
 * so ordinary repo movement cannot inflate the number. That is the failure that
 * retired the checkpoint model (epic Direction change), and this shape cannot
 * have it.
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

/** The trunk this branch's work is measured against. */
export type TrunkRef = {
  /** The ref the merge-base is taken with, e.g. `origin/develop` or `main`. */
  ref: string
  /** Its branch name, e.g. `develop` — what "am I ON the trunk?" compares to. */
  name: string
}

export type BranchSpan = {
  /** Branch name, or null on a detached HEAD or an unreadable repo. */
  branch: string | null
  /**
   * The commit the span measures from. `null` means there is nothing to measure
   * from — a detached HEAD, an unborn repo, no trunk to compare against, or
   * this checkout IS the trunk — and the span is then `HEAD → working tree`.
   */
  baseOid: string | null
  /** True when this cwd is a LINKED worktree, so nothing else writes into it. */
  isLinkedWorktree: boolean
  /** True when HEAD carries commits the trunk does not. */
  aheadOfBase: boolean
  /**
   * False when the diff itself could not be read — a bare repo, a locked index,
   * a corrupt object.
   *
   * Load-bearing, and the reason it exists: without it an unreadable span is a
   * confident zero, and a row that draws nothing for zero would silently claim
   * "this agent changed nothing" for work it simply failed to measure. That rule
   * came from the reading this file replaced and was lost in the move; it is
   * back, and callers must fall back rather than report a zero when this is
   * false.
   */
  readable: boolean
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
 * git's empty tree, the only thing an unborn HEAD can be diffed against. SHA-1
 * repos only; a SHA-256 repo has a different one, so its resolution is verified
 * rather than assumed and an unborn HEAD there simply reports nothing.
 */
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  const result = await runGitCommand(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  if (!result.ok) return null
  const oid = result.stdout.trim()
  return oid.length > 0 ? oid : null
}

async function resolveAnyObject(cwd: string, rev: string): Promise<string | null> {
  const result = await runGitCommand(cwd, ['rev-parse', '--verify', '--quiet', rev])
  if (!result.ok) return null
  const oid = result.stdout.trim()
  return oid.length > 0 ? oid : null
}

/** The branch part of a remote-tracking short name: `origin/feat` -> `feat`. */
function branchNameOf(shortRef: string): string {
  const slash = shortRef.indexOf('/')
  return slash === -1 ? shortRef : shortRef.slice(slash + 1)
}

/**
 * Which ref this branch's work should be measured against.
 *
 * Order matters, and each step exists because of a way the previous one is
 * wrong:
 *
 * 1. **`origin/HEAD`** is the only candidate that actually KNOWS the remote's
 *    default branch. Present after a clone; absent after `git init` + `remote
 *    add`, which is why the rest exist.
 * 2. **`@{upstream}`**, but never when it is this branch's OWN remote-tracking
 *    ref. After the ordinary `git push -u origin feat`, `@{upstream}` is
 *    `origin/feat`, whose merge-base with HEAD is HEAD — which would report a
 *    branch full of work as having produced nothing at all. Caught by review,
 *    reproduced, and guarded here rather than left to the ordering.
 * 3. **The conventional names**, remote before local.
 *
 * Among everything that resolves, the winner is the one whose merge-base is
 * CLOSEST to HEAD — fewest commits in `base..HEAD`. That is what keeps a repo
 * carrying both `origin/main` and `origin/master`, or a stale local trunk beside
 * a current remote one, from measuring against the ancient one.
 *
 * **Known limit, accepted:** a repo whose trunk is neither `main` nor `master`
 * AND which has no `origin/HEAD` cannot be detected — `develop` is not a name we
 * can guess. The reading then measures against whichever conventional name
 * exists, which over-reports. `git remote set-head origin -a` fixes it in the
 * user's repo; there is nothing correct we can do from here without guessing.
 */
export async function resolveTrunk(cwd: string, currentBranch: string | null): Promise<TrunkRef | null> {
  const candidates: TrunkRef[] = []
  const push = (ref: string, name: string): void => {
    if (!candidates.some((candidate) => candidate.ref === ref)) candidates.push({ ref, name })
  }

  const originHead = await runGitCommand(cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (originHead.ok) {
    const value = originHead.stdout.trim()
    if (value) push(value, branchNameOf(value))
  }

  const upstream = await runGitCommand(cwd, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ])
  if (upstream.ok) {
    const value = upstream.stdout.trim()
    const name = value ? branchNameOf(value) : ''
    // The self-tracking case. `origin/feat` for branch `feat` is not a trunk;
    // it is where this branch was last pushed.
    if (value && name && name !== currentBranch) push(value, name)
  }

  for (const name of ['main', 'master']) {
    push(`origin/${name}`, name)
    push(name, name)
  }

  let best: { trunk: TrunkRef; distance: number } | null = null
  for (const candidate of candidates) {
    if ((await resolveCommit(cwd, candidate.ref)) === null) continue
    const base = await runGitCommand(cwd, ['merge-base', 'HEAD', candidate.ref])
    if (!base.ok || !base.stdout.trim()) continue
    const counted = await runGitCommand(cwd, [
      'rev-list',
      '--count',
      `${base.stdout.trim()}..HEAD`,
    ])
    const distance = counted.ok ? Number.parseInt(counted.stdout.trim(), 10) : Number.NaN
    const safeDistance = Number.isFinite(distance) ? distance : Number.MAX_SAFE_INTEGER
    // Strictly less: ties keep the earlier, better-informed candidate.
    if (best === null || safeDistance < best.distance) {
      best = { trunk: candidate, distance: safeDistance }
    }
  }
  return best?.trunk ?? null
}

/**
 * The merge-base between HEAD and the resolved trunk, or null when there is
 * none to take — including the case that matters most: **this checkout IS the
 * trunk**.
 *
 * A workspace sitting on `main` whose local `main` leads `origin/main` has a
 * merge-base that is not HEAD, and comparing OIDs alone would call the person's
 * own unpushed commits the chat's branch work — every row in the repo reading
 * the same inflated number, which is the exact failure this epic exists to
 * remove. Being on the trunk is decided by NAME, not by distance.
 *
 * Deliberately not called on a detached HEAD: a detached checkout has no branch
 * whose work could be attributed, and merge-basing it against `origin/main`
 * would report the whole of history since the detach point as the agent's.
 */
export async function resolveBranchBase(cwd: string, currentBranch: string | null): Promise<string | null> {
  const trunk = await resolveTrunk(cwd, currentBranch)
  if (!trunk) return null
  if (currentBranch !== null && currentBranch === trunk.name) return null
  const base = await runGitCommand(cwd, ['merge-base', 'HEAD', trunk.ref])
  if (!base.ok) return null
  return base.stdout.trim() || null
}

/**
 * Whether `cwd` is a LINKED worktree rather than a repo's main working tree.
 *
 * `--git-dir` points at `<common>/worktrees/<name>` for a linked worktree and at
 * `<common>` for the main one, so the two answers differing IS the test. Both
 * are resolved to absolute paths first: git answers `--git-dir` relatively
 * (`.git`) from a repo root, and comparing `.git` against an absolute common dir
 * would call every main checkout a worktree.
 *
 * `--path-format=absolute` is git 2.31+ (March 2021) and this app documents no
 * minimum, so its failure falls back to resolving the relative answer against
 * cwd rather than silently reporting every worktree as a shared checkout — which
 * would have the tooltip tell someone their exclusive checkout might carry
 * another chat's work.
 */
export async function isLinkedWorktree(cwd: string): Promise<boolean> {
  const gitDir = await runGitCommand(cwd, ['rev-parse', '--absolute-git-dir'])
  if (!gitDir.ok) return false
  const own = gitDir.stdout.trim()
  if (!own) return false

  let common = ''
  const absolute = await runGitCommand(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (absolute.ok) {
    common = absolute.stdout.trim()
  } else {
    const relative = await runGitCommand(cwd, ['rev-parse', '--git-common-dir'])
    if (!relative.ok) return false
    const value = relative.stdout.trim()
    if (!value) return false
    common = isAbsolute(value) ? value : resolve(cwd, value)
  }
  if (!common) return false
  return resolve(own) !== resolve(common)
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

  // An unborn HEAD (fresh `git init`) has a branch name but no commit. Staged
  // content is still real work and is visible against git's empty tree, so it is
  // shown rather than dropped; a SHA-256 repo, whose empty tree is a different
  // object, reports nothing rather than a wrong number.
  if (headOid === null) {
    const emptyTree = await resolveAnyObject(cwd, EMPTY_TREE_SHA1)
    const stat = emptyTree ? await diffWorkingTreeFrom(cwd, emptyTree) : null
    return {
      branch,
      baseOid: null,
      isLinkedWorktree: await isLinkedWorktree(cwd),
      aheadOfBase: false,
      readable: stat !== null,
      stat: stat ?? emptyBranchSpanStat(),
    }
  }

  const baseOid = branch === null ? null : await resolveBranchBase(cwd, branch)
  const [isWorktree, stat] = await Promise.all([
    isLinkedWorktree(cwd),
    diffWorkingTreeFrom(cwd, baseOid ?? headOid),
  ])

  return {
    branch,
    baseOid,
    isLinkedWorktree: isWorktree,
    // Equality is still checked: a branch can be level with a trunk it is not
    // itself (a feature branch with nothing on it yet).
    aheadOfBase: baseOid !== null && baseOid !== headOid,
    readable: stat !== null,
    stat: stat ?? emptyBranchSpanStat(),
  }
}

/**
 * `git diff --numstat <from>` — staged and unstaged, against the working tree.
 * Null when the diff could not be run at all, which the caller must not report
 * as a zero.
 *
 * `--no-relative` because a workspace can be opened on a SUBDIRECTORY of its
 * repo: with the user's `diff.relative=true` set, git would both under-count
 * (only that subtree) and hand back cwd-relative paths that no other surface
 * here agrees with.
 *
 * Untracked files are invisible to `diff`, exactly as they are to the row's
 * previous reading and to the chrome's git badge: a file git has never tracked
 * has no line counts to report. The changed-files surface lists them
 * separately; a row that summarises edits does not.
 */
export async function diffWorkingTreeFrom(
  cwd: string,
  fromRev: string
): Promise<BranchSpanStat | null> {
  const result = await runGitCommand(cwd, [
    'diff',
    '--numstat',
    '-z',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    fromRev,
  ])
  if (!result.ok) return null
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
