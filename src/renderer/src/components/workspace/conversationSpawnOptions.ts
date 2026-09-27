import type { WorkspaceSkill } from '../../../../shared/electron-api'
import type { AgentConversationRuntime, AgentState, CliPermissionPreset } from '../../types/workspace'

// The agent-state fields that make a fresh agent a conversation-runtime agent.
// Shared by the spawn action and its test so the routing contract cannot drift:
// `runtimeKind`/`conversation` opt into AgentChatView, and the `cli*` fields are
// cleared so no terminal session is ever started for this agent.
export function conversationAgentRuntimePatch(providerId: string, modelId: string): Partial<AgentState> {
  return {
    runtimeKind: 'conversation',
    conversation: { providerId, modelId },
    cli: undefined,
    cliStartupPrompt: undefined,
    cliStartRequested: false,
    cliHasLaunched: false,
    cliResumeAvailable: false,
    cliSessionId: undefined,
  }
}

/**
 * What a launch hands a new chat agent besides its runtime: the skill chips, and
 * the typed prompt as the chat's first message. The prompt is SENT, not left in
 * the composer — Enter in the launcher starts the agent on what was typed, the
 * same as a terminal agent's startup prompt, so it must not need a second Enter.
 */
export function conversationLaunchDraftPatch(
  skills?: readonly Pick<WorkspaceSkill, 'id'>[],
  prompt?: string,
): Partial<AgentState> {
  return {
    ...(skills?.length ? { conversationSkills: skills.map((skill) => skill.id) } : {}),
    ...(prompt?.trim() ? { chatStartupPrompt: prompt.trim() } : {}),
  }
}

/**
 * The engine settings a launch carries onto a chat agent: the permission preset
 * the picker's footer shows for its CLI, and the effort it stands on (absent is
 * the CLI's own default, as for a terminal launch).
 */
export function conversationLaunchEnginePatch(launch: {
  permissionPreset: CliPermissionPreset
  reasoning?: string | null
}): Partial<AgentState> {
  return {
    cliPermissionPreset: launch.permissionPreset,
    ...(launch.reasoning ? { conversationReasoningEffort: launch.reasoning } : {}),
  }
}

/**
 * The agent a New chat door's chat-agent confirm opens. It carries no name: the
 * solo workspace names its lone agent from the shared pool, exactly as it does
 * for a terminal agent, so the chat is called what a terminal would be called
 * and never after its model. Null when the confirm names no provider.
 */
export function conversationNewChatSeed(
  confirm: {
    provider?: { providerId: string; modelId: string; modelLabel: string }
    skills?: readonly Pick<WorkspaceSkill, 'id'>[]
    reasoning?: string | null
  },
  launch: { prompt?: string; permissionPreset: CliPermissionPreset },
): { runtime: AgentConversationRuntime; agentPatch: Partial<AgentState> } | null {
  const target = confirm.provider
  if (!target) return null
  return {
    runtime: { providerId: target.providerId, modelId: target.modelId },
    agentPatch: {
      ...conversationAgentRuntimePatch(target.providerId, target.modelId),
      ...conversationLaunchEnginePatch({ permissionPreset: launch.permissionPreset, reasoning: confirm.reasoning }),
      ...conversationLaunchDraftPatch(confirm.skills, launch.prompt),
    },
  }
}
