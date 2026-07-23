// The host-action seam for the Extensions door (MC-1847 B1/B2). The door is a
// zero-prop registered surface, but three of its actions belong to the shell:
// "New chat" opens the new-chat composer with the connector attached, "Use in
// automation" opens the automation-authoring flow, and "Use in agent → New
// agent…" spawns a fresh agent with a skill attached. WorkspaceManager owns
// those routes (and closing the door around them), so it registers them here on
// mount — the same pure module-level-seam discipline as the automations
// surface-target latch: no store, no React, nothing in the eager module graph.

import type { WorkspaceSkill } from '../../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../agentComposer/AgentComposer'

export type ExtensionsSurfaceHostPorts = {
  /** Open the new-chat composer with this connector attached (nothing spawns
   *  until the user confirms there). Closes the door. */
  onLaunchConnector: (connector: AgentComposerConnector) => void
  /** Open the automation-authoring flow seeded with this connector. Closes the door. */
  onUseInAutomation: (serverId: string) => void
  /** Spawn a fresh agent with this skill ensure-installed and prefilled. Closes the door. */
  onUseSkillInNewAgent: (skill: WorkspaceSkill) => void
}

let ports: ExtensionsSurfaceHostPorts | null = null

/** WorkspaceManager registers its routes on mount and clears them on unmount. */
export function setExtensionsSurfaceHost(next: ExtensionsSurfaceHostPorts | null): void {
  ports = next
}

/** Read at call time by the door's action handlers. Null only when no
 *  WorkspaceManager is mounted (tests) — callers no-op then. */
export function getExtensionsSurfaceHost(): ExtensionsSurfaceHostPorts | null {
  return ports
}
