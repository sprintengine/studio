// Tab focus and the chat runtime list for module renderers
// (RendererHost.focusTab / listChatRuntimes). Ports are injected so the
// contract is unit-testable; modules/index wires the real store, layout
// helpers and CLI catalog at boot.

import { conversationProviderForCli } from '../../../shared/conversation-harness'
import type { ModuleChatRuntimeOption } from '../../../shared/modules/conversation-service'

export type ModuleFocusTabInput = {
  workspaceId: string
  kind: 'chat' | 'file'
  /** A chat's agent id (from `openChat` or the conversation service), or a workspace-relative file path. */
  id: string
}

export type WorkspaceTabPorts = {
  /** The workspace's effective working root and its agents; null when unknown. */
  getWorkspace: (
    workspaceId: string,
  ) => { workingRoot: string | null; agents: Array<{ id: string; name: string; isChat: boolean }> } | null
  /** Focus (or add) the agent's layout tab. */
  revealAgentTab: (workspaceId: string, agentId: string, name: string) => void
  focusFileTab: (workspaceId: string, absolutePath: string) => boolean
}

export type ModuleTabFocuser = (input: ModuleFocusTabInput) => boolean

export function createModuleTabFocuser(ports: WorkspaceTabPorts): ModuleTabFocuser {
  return (input) => {
    const workspace = ports.getWorkspace(input.workspaceId)
    if (!workspace) return false
    if (input.kind === 'chat') {
      // Only a chat: a terminal agent's id is not a module's to reveal, and an
      // unknown id returns false rather than minting a phantom tab.
      const agent = workspace.agents.find((candidate) => candidate.id === input.id)
      if (!agent?.isChat) return false
      ports.revealAgentTab(input.workspaceId, agent.id, agent.name)
      return true
    }
    if (!workspace.workingRoot) return false
    if (input.id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input.id) || input.id.split(/[\\/]+/).includes('..')) {
      return false
    }
    const root = workspace.workingRoot
    const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
    return ports.focusFileTab(input.workspaceId, `${root.replace(/[\\/]+$/, '')}${separator}${input.id}`)
  }
}

/** The slice of a CLI catalog row the chat runtime list reads. */
export type ChatCatalogOption = {
  value: string
  label: string
  installed?: boolean
  modelSelection?: { options: ReadonlyArray<{ id: string; label?: string }> }
}

/**
 * The CLIs a chat can run on, from the same availability-filtered catalog the
 * shell's chat picker reads: only rows with a conversation runtime, ids and
 * labels only (origin tags and "New" marks are picker internals).
 */
export function toModuleChatRuntimeOptions(
  catalog: readonly ChatCatalogOption[],
  lastSelectedCli: string | null,
): ModuleChatRuntimeOption[] {
  return catalog
    .filter((option) => conversationProviderForCli(option.value) !== null)
    .map((option) => ({
      id: option.value,
      label: option.label,
      // The catalog is availability-filtered, so a row that is here is
      // installed unless detection explicitly said otherwise.
      available: option.installed !== false,
      models: (option.modelSelection?.options ?? []).map((model) => ({ id: model.id, label: model.label ?? model.id })),
      lastSelected: option.value === lastSelectedCli,
    }))
}
