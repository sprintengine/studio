import { conversationNewChatSeed } from '../conversationSpawnOptions'
import { conversationProviderForCli, CONVERSATION_DEFAULT_MODEL_ID } from '../../../../../shared/conversation-harness'
import type { ModuleOpenChatResult } from '../../../../../shared/modules/conversation-service'
import type { WorkspaceChatOpener } from '../../../modules/chat-opener'
import type { AgentState, CliPermissionPreset } from '../../../types/workspace'

// What `RendererHost.openChat` does once the shell has a store to do it in
// (see modules/chat-opener.ts): a chat agent seeded into a workspace that is
// already open, stamped with the module that asked, and brought to the front.
//
// It is a new agent in THAT workspace, never a new workspace: the module named
// the workspace, and a chat that appeared somewhere else would not be the one it
// asked for. The record is the one a New chat writes (`conversationNewChatSeed`)
// plus `ownerModuleId`, so the module's conversation service can reach it and
// the sidebar lists it like any other chat.
//
// The prompt is a draft unless the module asked to send it (`send: true`): a
// module putting words in the person's mouth should leave them where the person
// can read them first. Sent, it is the chat's first message — the same one-shot
// a launcher's prompt is.
//
// Store-free, so every refusal is tested without a window: WorkspaceManager
// hands in the reads and writes.

export type WorkspaceChatOpenerDeps = {
  getWorkspace: (
    workspaceId: string,
  ) => { folderPath: string | null | undefined; agents: Record<string, { name: string }> } | null
  /** The CLI the person last chose, the one a chat runs on when the module names none. */
  lastSelectedCli: () => string | null | undefined
  /** The permission preset the person's launches of this CLI run on. */
  permissionPresetFor: (cli: string) => CliPermissionPreset
  /** The CLI's own mode chosen with that preset, when it is not the preset's own. */
  permissionModeFor?: (cli: string) => string | undefined
  newAgentId: (providerId: string) => string
  pickName: (taken: string[]) => string
  writeAgent: (workspaceId: string, agentId: string, patch: Partial<AgentState>) => void
  /** Park the prompt in the new chat's composer. */
  putDraft: (workspaceId: string, agentId: string, draft: { text: string; skillIds: string[] }) => void
  /** Make the skills exist in the workspace before the chat's first message attaches them. */
  ensureSkills: (workspaceRoot: string, skillIds: string[]) => void
  /** Bring the chat's tab to the front, clearing any door over it. */
  reveal: (workspaceId: string, agentId: string, name: string) => void
}

function refuse(code: Exclude<ModuleOpenChatResult, { ok: true }>['code'], message: string): ModuleOpenChatResult {
  return { ok: false, code, message }
}

export function createWorkspaceChatOpener(deps: WorkspaceChatOpenerDeps): WorkspaceChatOpener {
  return async (input) => {
    const workspace = deps.getWorkspace(input.workspaceId)
    if (!workspace) {
      return refuse('unknown_workspace', `There is no open workspace "${input.workspaceId}" to open a chat in.`)
    }
    const folderPath = workspace.folderPath?.trim()
    if (!folderPath) {
      return refuse(
        'workspace_folder_missing',
        'That workspace has no project folder, so there is nowhere for a chat to work.',
      )
    }

    const cli = input.cli?.trim() || deps.lastSelectedCli()?.trim() || ''
    const providerId = conversationProviderForCli(cli)
    if (!providerId) {
      return refuse(
        'cli_not_conversational',
        cli
          ? `"${cli}" cannot run as a chat agent here. Ask for another CLI, or leave it out to use the person's own.`
          : 'No agent CLI is chosen on this machine to run a chat on.',
      )
    }
    const modelId = input.model?.trim() || CONVERSATION_DEFAULT_MODEL_ID
    const skillIds = [...new Set((input.skills ?? []).map((id) => id.trim()).filter(Boolean))]
    const prompt = input.prompt?.trim() ?? ''
    const send = input.send === true

    const seed = conversationNewChatSeed(
      { provider: { providerId, modelId, modelLabel: modelId }, skills: skillIds.map((id) => ({ id })) },
      {
        ...(send && prompt ? { prompt } : {}),
        permissionPreset: deps.permissionPresetFor(cli),
        ...(deps.permissionModeFor?.(cli) ? { permissionMode: deps.permissionModeFor(cli) } : {}),
      },
    )
    if (!seed) return refuse('cli_not_conversational', `"${cli}" cannot run as a chat agent here.`)

    const agentId = deps.newAgentId(providerId)
    const name = deps.pickName(Object.values(workspace.agents).map((agent) => agent.name))
    deps.writeAgent(input.workspaceId, agentId, { name, ...seed.agentPatch, ownerModuleId: input.moduleId })
    if (!send && prompt) deps.putDraft(input.workspaceId, agentId, { text: prompt, skillIds })
    if (skillIds.length > 0) deps.ensureSkills(folderPath, skillIds)
    deps.reveal(input.workspaceId, agentId, name)
    return { ok: true, agentId }
  }
}
