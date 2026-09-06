import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import { observedCheckoutKind } from '../../../../shared/observed-checkout'
import type { AgentExecution } from '../../../../shared/sprintengine/agent-state'
import type { AgentTabCheckout } from './AgentTabIdentityPopover'

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
  launch: AgentLaunchIntent
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
  const launchWorktree =
    launch.workspaceWorktree
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
 * The checkout a surface should ask git about for this agent, or the
 * fallback when the agent's own answer names no checkout — a folder, a
 * removed directory, an unverified path, or no observation and no intent.
 * The fallback is the caller's notion of the workspace's checkout.
 */
export function agentCheckoutProbePath(checkout: AgentCheckout | null, fallback: string | null): string | null {
  return checkout?.gitRoot ?? fallback
}
