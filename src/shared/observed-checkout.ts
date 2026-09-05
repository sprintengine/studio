/**
 * Observed checkout (MC-2440): where an agent session actually IS, as reported
 * by its CLI's lifecycle hooks, resolved through git into the checkout that
 * contains it.
 *
 * This is deliberately kept apart from launch intent (`execution.cwd`,
 * `worktreePath`): those say where the app PUT the agent; this says where the
 * agent's hooks last saw it. An agent that creates a worktree and moves into
 * it, or is launched by hand into a worktree the app never made, is only
 * describable from this side.
 *
 * Node-free so the renderer and the main process share one shape.
 */

export type ObservedCheckout = {
  /** The cwd exactly as the hook payload reported it (verbatim, untrusted-but-shape-checked). */
  cwd: string
  /** Epoch ms of the frame that carried the cwd. */
  at: number
  /**
   * False until git has answered for this cwd. While false every git-derived
   * field below is null/false and a consumer should fall back to launch intent
   * rather than read "not a checkout" into the nulls.
   */
  resolved: boolean
  /** Top level of the checkout containing `cwd` (realpath, from git); null when not inside a git work tree. */
  gitRoot: string | null
  /**
   * Root of the PRIMARY checkout this working tree belongs to: for a linked
   * worktree, the checkout that owns the common git dir; for a primary
   * checkout, `gitRoot` itself. Null when unknown (bare/odd layouts, not a repo).
   */
  repoRoot: string | null
  /** Current branch, or null on a detached HEAD / not a repo. */
  branch: string | null
  /** True when `gitRoot` is a linked worktree (`git worktree add`), false for a primary checkout or a non-repo. */
  isLinkedWorktree: boolean
}

/** Cap on a reported cwd; a longer value signals a broken reporter and drops the field. */
export const MAX_OBSERVED_CWD_LENGTH = 4096

/**
 * Whether a reporter-supplied cwd has the shape of an absolute path on any
 * platform we launch agents on: POSIX (`/…`), a Windows drive (`C:\…`, `C:/…`),
 * or UNC (`\\server\share`). A relative value is meaningless off the reporting
 * process's own cwd, so it is rejected rather than resolved.
 */
export function isAbsoluteObservedPath(value: string): boolean {
  if (value.length === 0) return false
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return false
}

/** An observation that carries only the cwd, before git has answered. */
export function unresolvedObservedCheckout(cwd: string, at: number): ObservedCheckout {
  return { cwd, at, resolved: false, gitRoot: null, repoRoot: null, branch: null, isLinkedWorktree: false }
}

/**
 * The checkout kind a consumer renders. `unknown` while unresolved (fall back
 * to launch intent); `folder` when the cwd is outside every git work tree.
 */
export type ObservedCheckoutKind = 'unknown' | 'worktree' | 'main' | 'folder'

export function observedCheckoutKind(checkout: ObservedCheckout | null | undefined): ObservedCheckoutKind {
  if (!checkout || !checkout.resolved) return 'unknown'
  if (!checkout.gitRoot) return 'folder'
  return checkout.isLinkedWorktree ? 'worktree' : 'main'
}
