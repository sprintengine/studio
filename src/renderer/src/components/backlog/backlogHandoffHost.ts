// The host seam for "Hand to agent" on a Backlog item, mirroring
// `extensionsSurfaceHost`: the button is mounted by the item detail pane, which
// both the workspace panel and the Backlog door render, and neither of them
// owns agent creation. WorkspaceManager does, so it registers the route here on
// mount and the button reads it at click time — no prop threaded through two
// surfaces, and nothing but types in the eager module graph (no store, no
// React).

import type { AgentCli } from '../../types/workspace'

export type BacklogHandoffRequest = {
  /** The item's OWN project root — never the active workspace's. */
  workspaceRoot: string
  relativePath: string
  /** The scanned title, for the agent-side glyph tooltip. */
  title: string
  cli: AgentCli
  /** The picked model, or null for the CLI's own default. */
  model: string | null
}

export type BacklogHandoffHostPorts = {
  /**
   * Launch a fresh agent on the picked engine, scoped to the item's project,
   * whose first input is the Backlog skill invocation for the item — then
   * record the item ↔ agent link on both sides. Resolves when the launch has
   * been requested; diagnostics for a failed one are the host's.
   */
  handToAgent: (request: BacklogHandoffRequest) => Promise<void>
}

let ports: BacklogHandoffHostPorts | null = null

/** WorkspaceManager registers its route on mount and clears it on unmount. */
export function setBacklogHandoffHost(next: BacklogHandoffHostPorts | null): void {
  ports = next
}

/** Read at click time. Null only when no WorkspaceManager is mounted (tests),
 *  where the button withholds itself rather than offering a dead control. */
export function getBacklogHandoffHost(): BacklogHandoffHostPorts | null {
  return ports
}
