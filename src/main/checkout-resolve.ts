/**
 * Resolve an observed cwd into the checkout that contains it (MC-2440).
 *
 * The cwd comes from an agent's lifecycle hooks — it says where the session
 * IS, not what kind of checkout that is. Git answers the second question:
 *
 *   - `rev-parse --show-toplevel`        → the work tree root (realpath-resolved)
 *   - `rev-parse --git-common-dir` vs
 *     `rev-parse --absolute-git-dir`      → a linked worktree has its own git
 *                                           dir apart from the common one
 *   - the common dir's parent             → the PRIMARY checkout the worktree
 *                                           belongs to (`<root>/.git` ⇒ root)
 *   - `symbolic-ref --short HEAD`         → the branch (null when detached)
 *
 * Three outcomes, kept distinct because a consumer renders them differently:
 *   1. a checkout (facts, `gitRoot` set) — primary or linked worktree;
 *   2. not a checkout (`gitRoot` null) — a plain folder, a removed worktree, a
 *      bare repo's directory, the inside of a `.git` dir;
 *   3. null — git could not answer at all (binary missing, a path this host
 *      cannot run git in such as a WSL path reported to a Windows main). The
 *      caller leaves the observation unresolved and falls back to launch
 *      intent rather than reading "folder" into a tooling failure.
 */
import { basename, dirname, isAbsolute, resolve } from 'path'
import type { ObservedCheckout } from '../shared/observed-checkout'
import { pathExists, runGitCommand } from './git-utils'

export type ResolvedCheckoutFacts = Pick<ObservedCheckout, 'gitRoot' | 'repoRoot' | 'branch' | 'isLinkedWorktree'>

export type ObservedCheckoutResolver = (cwd: string) => Promise<ResolvedCheckoutFacts | null>

export const NOT_A_CHECKOUT: ResolvedCheckoutFacts = Object.freeze({
  gitRoot: null,
  repoRoot: null,
  branch: null,
  isLinkedWorktree: false,
})

// Git's own vocabulary for "there is no repository / work tree here" — every
// other failure is git not answering, which must not be read as a plain folder.
const NOT_A_REPO_PATTERNS = [
  /not a git repository/i,
  /must be run in a work tree/i,
  /cannot be used without a working tree/i,
  /this operation must be run in a work tree/i,
]

function saysNotARepo(stderr: string, message: string | null): boolean {
  const text = `${stderr}\n${message ?? ''}`
  return NOT_A_REPO_PATTERNS.some((pattern) => pattern.test(text))
}

// git prints paths forward-slashed on every platform; a Windows toplevel comes
// back as `C:/…`. Keep git's own form (it is realpath-resolved, and every
// comparison the renderer makes is separator- and case-insensitive).
function firstLine(stdout: string): string {
  return stdout.split(/\r?\n/)[0]?.trim() ?? ''
}

/**
 * The path THIS host can run git in for a reported cwd, or null when it
 * cannot. A CLI launched through WSL reports Linux paths to a Windows main:
 * `/mnt/<drive>/…` is the Windows drive seen from inside WSL and translates
 * back; any other Linux-absolute path lives inside the WSL filesystem, which
 * git on the Windows side cannot open — that is "unresolved", never "folder".
 * The mirror case (a Windows-form path reaching a POSIX main) is likewise
 * unanswerable. Exported for its unit test; the platform is injectable.
 */
export function hostCwdForResolution(cwd: string, platform: NodeJS.Platform = process.platform): string | null {
  const windowsForm = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
  if (platform === 'win32') {
    if (windowsForm) return cwd
    const wsl = cwd.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/)
    if (wsl) return `${wsl[1].toUpperCase()}:/${wsl[2] ?? ''}`
    return null
  }
  return windowsForm ? null : cwd
}

export async function resolveCheckoutForCwd(reportedCwd: string): Promise<ResolvedCheckoutFacts | null> {
  const cwd = hostCwdForResolution(reportedCwd)
  if (!cwd) return null

  // A vanished directory (a pruned worktree) is honestly "not a checkout": the
  // git call would fail with a chdir error that says nothing about repositories.
  if (!(await pathExists(cwd))) return NOT_A_CHECKOUT

  const top = await runGitCommand(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return saysNotARepo(top.stderr, top.message) ? NOT_A_CHECKOUT : null
  const gitRoot = firstLine(top.stdout)
  if (!gitRoot) return NOT_A_CHECKOUT

  const own = await runGitCommand(cwd, ['rev-parse', '--absolute-git-dir'])
  const ownGitDir = own.ok ? firstLine(own.stdout) : ''

  // `--path-format=absolute` needs git ≥ 2.31; older builds answer relative to
  // the cwd (mirrors isLinkedWorktree in git-branch-span.ts).
  let commonGitDir = ''
  const absolute = await runGitCommand(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (absolute.ok) {
    commonGitDir = firstLine(absolute.stdout)
  } else {
    const relative = await runGitCommand(cwd, ['rev-parse', '--git-common-dir'])
    if (relative.ok) {
      const value = firstLine(relative.stdout)
      if (value) commonGitDir = isAbsolute(value) ? value : resolve(cwd, value)
    }
  }

  const isLinkedWorktree = Boolean(ownGitDir && commonGitDir && resolve(ownGitDir) !== resolve(commonGitDir))
  // The primary checkout owns the common git dir as `<root>/.git`; anything
  // else (a bare repository, an unusual GIT_DIR layout) has no primary work
  // tree to point at.
  const repoRoot = commonGitDir && basename(commonGitDir) === '.git'
    ? dirname(commonGitDir)
    : isLinkedWorktree ? null : gitRoot

  const head = await runGitCommand(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = head.ok ? firstLine(head.stdout) || null : null

  return { gitRoot, repoRoot, branch, isLinkedWorktree }
}
