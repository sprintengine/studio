import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import { observedCheckoutKind } from '../../../../shared/observed-checkout'
import type { AgentExecution } from '../../../../shared/agent-runtime'

/**
 * The shapes a checkout can take, before a git root is attached. Named for the
 * tab that first needed the vocabulary; it now describes every surface that
 * says where an agent runs. `observed: true` means the session's own lifecycle
 * hooks reported the directory and git resolved it; `observed: false` is the
 * app's launch intent, standing in until the first hook frame answers.
 */
export type AgentTabCheckout =
  | { kind: 'worktree'; branch: string | null; cwd: string | null; observed: boolean }
  | { kind: 'main'; branch: string | null; cwd: string | null; observed: true }
  | { kind: 'folder'; cwd: string; observed: true }
  // The observed directory no longer exists (a worktree pruned under the agent).
  | { kind: 'missing'; cwd: string; observed: true }
  // A cwd was observed but git could not answer for it on this host (no git,
  // a WSL-internal path on a Windows main): say where, claim nothing more.
  | { kind: 'unverified'; cwd: string; observed: true }

/**
 * Where an agent runs — ONE answer, shared by every surface that says so
 * (sidebar-lists-every-terminal): the tab glyph and identity card, the
 * sidebar row's per-terminal line, and the branch chip that follows the
 * focused agent. Three surfaces reading three resolutions would disagree the
 * moment an agent moved; they read this one.
 *
 * Observed first (MC-2440): the session's own hooks report its cwd and git
 * resolves it, so an agent that created a worktree and moved into it — or
 * left one — is shown where it actually is. Until that answers, launch
 * intent: workspace-level (any agent in a worktree-backed workspace, because
 * the cwd-redirect slices run every terminal in the worktree) or the
 * per-agent persisted `execution.mode === 'worktree'`.
 *
 * `gitRoot` is what a git probe should be pointed at — the checkout, never the
 * observed cwd (which may be a subdirectory). Null when there is nothing to
 * probe: a plain folder, a removed directory, an unverifiable path.
 */
export type AgentCheckout = AgentTabCheckout & { gitRoot: string | null }

export type AgentLaunchIntent = {
  /** The workspace's own worktree when it is worktree-backed, else null. */
  workspaceWorktree: { gitRoot: string; branch: string | null } | null
  /** The agent's persisted launch decision, when the agent is known. */
  execution: Pick<AgentExecution, 'mode' | 'cwd'> | null
}

export function agentCheckoutOf(
  session: Pick<TerminalSessionSnapshot, 'observedCheckout'> | null | undefined,
  launch: AgentLaunchIntent,
): AgentCheckout | null {
  const observed = session?.observedCheckout
  const observedKind = observedCheckoutKind(observed)
  if (observed && observedKind === 'worktree') {
    return { kind: 'worktree', branch: observed.branch, cwd: observed.cwd, gitRoot: observed.gitRoot, observed: true }
  }
  if (observed && observedKind === 'main') {
    return { kind: 'main', branch: observed.branch, cwd: observed.cwd, gitRoot: observed.gitRoot, observed: true }
  }
  if (observed && observedKind === 'folder') {
    return { kind: 'folder', cwd: observed.cwd, gitRoot: null, observed: true }
  }
  if (observed && observedKind === 'missing') {
    return { kind: 'missing', cwd: observed.cwd, gitRoot: null, observed: true }
  }
  // Launch intent. A per-agent worktree claims no branch: the app never
  // resolved one at launch, and inventing it here would be a claim the
  // observation then corrects.
  const launchWorktree = launch.workspaceWorktree
    ? { cwd: launch.workspaceWorktree.gitRoot, branch: launch.workspaceWorktree.branch }
    : launch.execution?.mode === 'worktree'
      ? { cwd: launch.execution.cwd ?? null, branch: null }
      : null
  if (launchWorktree) {
    return { kind: 'worktree', ...launchWorktree, gitRoot: launchWorktree.cwd, observed: false }
  }
  // A cwd was observed but git could not answer for it on this host: say
  // where, claim nothing more.
  if (observed) return { kind: 'unverified', cwd: observed.cwd, gitRoot: null, observed: true }
  return null
}

/**
 * The checkout a surface should ask git about for this agent. The fallback —
 * the caller's notion of the workspace's checkout — applies only when
 * NOTHING is known: no observation and no launch intent. An agent git has
 * placed in a plain folder, a removed directory or an unverifiable path has
 * no checkout to ask about, and the workspace's branch is not its answer;
 * a worktree intended but never given a cwd is the same.
 */
export function agentCheckoutProbePath(checkout: AgentCheckout | null, fallback: string | null): string | null {
  return checkout === null ? fallback : checkout.gitRoot
}
