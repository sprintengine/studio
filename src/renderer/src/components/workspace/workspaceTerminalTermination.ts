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
 * Kill every terminal session the workspace holds. The returned promise settles
 * once main has acknowledged each kill — the pty has been signalled and the
 * session dropped from the registry — which is as close to "this workspace's
 * writers are done" as the renderer can get. Kill failures are absorbed: a
 * session that died first must not hold up the caller.
 *
 * Three callers, and they are the whole list of ways a workspace stops running:
 * Close (the chat is removed), Delete (its state is trashed, and the kill has
 * to land BEFORE the folder goes so a surviving writer cannot recreate it), and
 * Settle (2026-09-07) — a chat that has come to rest holds no ptys, whether a
 * person settled it by hand or the sweep did after three idle days.
 *
 * It lives here rather than in WorkspaceManager, where it grew up, because
 * settling is driven from the sidebar: one copy, so the three paths cannot
 * drift about what "this workspace's terminals" means — the agents' CLI
 * sessions, the layout's agent and terminal tabs, and the pane's own terminal
 * tabs, which own ptys the layout knows nothing about.
 */
export async function terminateWorkspaceTerminals(workspace: Workspace): Promise<void> {
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

  await Promise.all(
    [...sessionIds].map((sessionId) => window.api.terminalKill(sessionId).catch(() => {})),
  )
}
