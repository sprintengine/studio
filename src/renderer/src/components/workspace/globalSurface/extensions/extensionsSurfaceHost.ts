// The host-action seam for the Extensions door (MC-1847 B1/B2). The door is a
// zero-prop registered surface, but four of its actions belong to the shell:
// "New chat" opens the new-chat composer with the connector attached, "Use in
// automation" opens the automation-authoring flow, and "Use in agent → New
// agent…" spawns a fresh agent with a skill attached. WorkspaceManager owns
// those routes (and closing the door around them), so it registers them here on
// mount — the same pure module-level-seam discipline as the automations
// surface-target latch: no store, no React, nothing in the eager module graph.

import type { WorkspaceSkill } from '../../../../../../shared/electron-api'
import type { HostedCard } from '../../../../../../shared/hosted-card-feed'
import type { AgentComposerConnector } from '../../agentComposer/AgentComposer'
import type { CardLaunchChoice } from './home/CardGoPicker'

export type ExtensionsSurfaceHostPorts = {
  /** Open the new-chat composer with this connector attached (nothing spawns
   *  until the user confirms there). Closes the door. */
  onLaunchConnector: (connector: AgentComposerConnector) => void
  /** Open the automation-authoring flow seeded with this connector. Closes the door. */
  onUseInAutomation: (serverId: string) => void
  /** Spawn a fresh agent with this skill ensure-installed and prefilled. Closes the door. */
  onUseSkillInNewAgent: (skill: WorkspaceSkill) => void
  /**
   * `Go` on a card on the Extensions home (item 2469): run the card's ordered
   * actions in the workspace the person is in, then land them where the card
   * said — a chat with the prompt SENT, or a door.
   *
   * `launch` is the model row the person chose in the picker `Go` opens (item
   * 2473, ruling R4b): choosing a row is what starts the run, so the run is
   * never asked for without one. Its cli, model, reasoning and permission preset
   * are what the chat is spawned on.
   *
   * It is here for the same reason the three above are: the surface knows
   * nothing about the open workspace, the MCP settings store, where projects
   * live or how an agent is spawned, and all four are the shell's. The promise
   * settles when the run is over — which is what lets the card's one button
   * disable itself for exactly as long as it is working — and it never rejects:
   * a failure is a toast the shell has already shown.
   */
  onRunCard: (card: HostedCard, launch: CardLaunchChoice) => Promise<void>
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
