import { paneTerminalSessionId } from './pane/paneTerminals'
import type { Workspace } from '../../types/workspace'

type LayoutSessionNode = {
  component?: string
  config?: {
    agentId?: string
    terminalId?: string
  }
  children?: LayoutSessionNode[]
}

/**
 * Every terminal session this workspace holds — the agents' CLI sessions, the
 * layout's agent and terminal tabs, and the pane's own terminal tabs, which own
 * ptys the layout knows nothing about.
 *
 * One collector, so the paths that stop a workspace running cannot drift about
 * what "this workspace's terminals" means.
 */
export function workspaceTerminalSessionIds(workspace: Workspace): string[] {
  const sessionIds = new Set<string>()

  Object.values(workspace.agents ?? {}).forEach((agent) => {
    if (agent.cliSessionId) sessionIds.add(agent.cliSessionId)
  })

  const collectLayoutSessions = (node: LayoutSessionNode | undefined) => {
    if (!node) return

    if (node.component === 'agent') {
      const agentId = node.config?.agentId
      const sessionId = agentId ? workspace.agents[agentId]?.cliSessionId : undefined
      if (sessionId) sessionIds.add(sessionId)
    }

    if (node.component === 'terminal') {
      const terminalId = node.config?.terminalId
      if (terminalId) sessionIds.add(`terminal-${terminalId}`)
    }

    node.children?.forEach(collectLayoutSessions)
  }

  // Optional-chained through the layout, not because the type says it can be
  // missing but because Settle now runs this over whatever the sweep decided
  // — a record that predates a field, or one a failed write left half-formed,
  // must not throw inside a sweep and strand the rest of the batch.
  collectLayoutSessions(workspace.layoutModel?.layout as LayoutSessionNode | undefined)
  workspace.layoutModel?.borders?.forEach((border) => collectLayoutSessions(border as LayoutSessionNode))
  // The pane's terminal tabs own ptys the layout knows nothing about.
  for (const tab of workspace.paneState?.tabs ?? []) {
    if (tab.kind === 'terminal' && tab.terminalId) sessionIds.add(paneTerminalSessionId(tab.terminalId))
  }

  return [...sessionIds]
}

/**
 * Kill every terminal session the workspace holds. The returned promise settles
 * once main has acknowledged each kill — the pty has been signalled and the
 * session dropped from the registry — which is as close to "this workspace's
 * writers are done" as the renderer can get. Kill failures are absorbed: a
 * session that died first must not hold up the caller.
 *
 * Three callers, and they are the whole list of ways a workspace stops running
 * for good: Close (the chat is removed), Delete (its state is trashed, and the
 * kill has to land BEFORE the folder goes so a surviving writer cannot recreate
 * it), and Settle (2026-09-07) — a chat that has come to rest holds no ptys,
 * whether a person settled it by hand or the sweep did after three idle days.
 *
 * It lives here rather than in WorkspaceManager, where it grew up, because
 * settling is driven from the sidebar.
 */
export async function terminateWorkspaceTerminals(workspace: Workspace): Promise<void> {
  await Promise.all(
    workspaceTerminalSessionIds(workspace).map((sessionId) => window.api.terminalKill(sessionId).catch(() => {})),
  )
}

/**
 * PAUSE every terminal session the workspace holds, rather than killing them.
 * Snooze's half of the pair (owner ruling, 2026-09-10).
 *
 * A snoozed chat must sit exactly as the app's other non-live chats do: no
 * agent process running, the row just there. Snooze first shipped as
 * visibility-only — the row left the list and every pty stayed up — which made
 * a chat you had told to go away the most expensive kind of row in the tree,
 * holding a CLI process for the whole snooze. Visibility-only is the right rule
 * for a snooze whose session lives on a SERVER, where hiding costs nothing;
 * ours holds a live local process, so hiding the row is not putting it away.
 *
 * Suspend rather than kill because a snoozed chat is coming back on a clock.
 * `terminalSuspend` ends the agent PROCESS but keeps the painted, resumable
 * session, and the first keystroke relaunches it under the same session id with
 * `--resume` (TerminalView's `resumeFromSuspend`). Nothing here and nothing on
 * the wake path resumes anything: waking returns the row to the sidebar with
 * its terminals still paused, and the person's own keystroke is what starts an
 * agent again.
 *
 * Failures are absorbed for the reason the kill path absorbs them: a session
 * that is already gone must not hold up a gesture whose whole job is to get a
 * row out of the way.
 */
export async function suspendWorkspaceTerminals(workspace: Workspace): Promise<void> {
  await Promise.all(
    workspaceTerminalSessionIds(workspace).map((sessionId) => window.api.terminalSuspend(sessionId).catch(() => {})),
  )
}
