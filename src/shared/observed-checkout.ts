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

import { isRecord } from './records'

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
  /**
   * True when the observed cwd no longer exists on disk (a worktree pruned out
   * from under the agent). Only meaningful with `resolved: true` and no
   * `gitRoot`; distinguishes "removed" from a plain folder.
   */
  missing?: boolean
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
  if (/^\\\\[^\\]/.test(value)) return true
  return false
}

function optionalPath(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_OBSERVED_CWD_LENGTH ? value : null
}

/**
 * Shape-check a persisted observation (the terminal snapshot sidecar survives
 * an app restart, so it is read as untrusted). Null for anything that is not
 * a well-formed observation; git-derived fields are re-read defensively so a
 * hand-edited or older sidecar cannot smuggle in an inconsistent record.
 */
export function parseObservedCheckout(raw: unknown): ObservedCheckout | null {
  if (!isRecord(raw)) return null
  const cwd = optionalPath(raw.cwd)
  if (!cwd || !isAbsoluteObservedPath(cwd)) return null
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null
  if (at === null) return null
  const resolved = raw.resolved === true
  if (!resolved) return unresolvedObservedCheckout(cwd, at)
  const absolutePath = (value: unknown): string | null => {
    const path = optionalPath(value)
    return path && isAbsoluteObservedPath(path) ? path : null
  }
  const gitRoot = absolutePath(raw.gitRoot)
  return {
    cwd,
    at,
    resolved: true,
    gitRoot,
    repoRoot: gitRoot ? absolutePath(raw.repoRoot) : null,
    branch:
      gitRoot && typeof raw.branch === 'string' && raw.branch.length > 0 && raw.branch.length <= 512
        ? raw.branch
        : null,
    isLinkedWorktree: Boolean(gitRoot) && raw.isLinkedWorktree === true,
    ...(!gitRoot && raw.missing === true ? { missing: true } : {}),
  }
}

/** Field-wise equality, so a re-resolution that changed nothing broadcasts nothing. */
export function sameObservedCheckout(
  a: ObservedCheckout | null | undefined,
  b: ObservedCheckout | null | undefined,
): boolean {
  if (!a || !b) return a === b || (!a && !b)
  return (
    a.cwd === b.cwd &&
    a.at === b.at &&
    a.resolved === b.resolved &&
    a.gitRoot === b.gitRoot &&
    a.repoRoot === b.repoRoot &&
    a.branch === b.branch &&
    a.isLinkedWorktree === b.isLinkedWorktree &&
    (a.missing ?? false) === (b.missing ?? false)
  )
}

/** An observation that carries only the cwd, before git has answered. */
export function unresolvedObservedCheckout(cwd: string, at: number): ObservedCheckout {
  return { cwd, at, resolved: false, gitRoot: null, repoRoot: null, branch: null, isLinkedWorktree: false }
}

/**
 * The checkout kind a consumer renders. `unknown` while unresolved (fall back
 * to launch intent, showing the raw cwd as unverified); `folder` when the cwd
 * is outside every git work tree; `missing` when it no longer exists at all.
 */
export type ObservedCheckoutKind = 'unknown' | 'worktree' | 'main' | 'folder' | 'missing'

export function observedCheckoutKind(checkout: ObservedCheckout | null | undefined): ObservedCheckoutKind {
  if (!checkout || !checkout.resolved) return 'unknown'
  if (!checkout.gitRoot) return checkout.missing ? 'missing' : 'folder'
  return checkout.isLinkedWorktree ? 'worktree' : 'main'
}
