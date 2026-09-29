// The seams behind "Build your own extension" (BuildExtensionFlow.tsx).
//
// The flow lives on the Extensions home, but the chat it ends in is the
// shell's: a new chat is a solo workspace WorkspaceManager creates, so the
// manager registers the route here on mount — the same module-level-seam
// discipline as `extensionsSurfaceHost.ts`, with nothing in the eager graph.
//
// And the flow can be asked for from outside the page — the command palette —
// before the page is even open, so a request is LATCHED: whoever asks sets it
// and opens the door; the page takes it when it mounts (or at once, if it is
// already up and subscribed). Latch first, open second, the order every
// deep-link opener in the shell uses.

import type { WorkspaceSkill } from '../../../../shared/electron-api'
import type { AgentCli } from '../../types/workspace'

/** The chat a built project opens in, as the New chat door's conversation confirm names one. */
export type BuildExtensionChatLaunch = {
  /** The scaffolded project; the chat's workspace is a new one on this folder. */
  folder: string
  confirm: {
    provider: { providerId: string; modelId: string; modelLabel: string }
    cli: AgentCli
    reasoning: string | null
    skills: Pick<WorkspaceSkill, 'id'>[]
  }
  /** Sent as the chat's first message. */
  prompt: string
}

export type BuildExtensionHostPorts = {
  /** Open the project in a new chat on the chosen agent, with the prompt sent. */
  openChat: (launch: BuildExtensionChatLaunch) => void
}

let ports: BuildExtensionHostPorts | null = null

/** WorkspaceManager registers its route on mount and clears it on unmount. */
export function setBuildExtensionHost(next: BuildExtensionHostPorts | null): void {
  ports = next
}

/** Null only when no WorkspaceManager is mounted (tests). */
export function getBuildExtensionHost(): BuildExtensionHostPorts | null {
  return ports
}

let requested = false
const listeners = new Set<() => void>()

/** Ask the Extensions home to open the build flow. The caller opens the home. */
export function requestBuildExtensionFlow(): void {
  requested = true
  for (const listener of listeners) listener()
}

/** Whether the flow was asked for since the last take; taking clears it. */
export function takeBuildExtensionFlowRequest(): boolean {
  const was = requested
  requested = false
  return was
}

export function subscribeBuildExtensionFlowRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
