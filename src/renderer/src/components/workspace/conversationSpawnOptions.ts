import type { ConversationProviderListResult } from '../../../../shared/electron-api'
import type { AgentConversationRuntime, AgentState } from '../../types/workspace'

// One selectable spawn row in the agent menu: a single provider/model pair the
// user can launch as a conversation-backed agent. Provider and model ids are
// passed straight to `addNewConversationAgent`, so they must be preserved
// exactly as the provider catalog returned them — labels are display-only.
export type ConversationSpawnOption = {
  providerId: string
  providerLabel: string
  modelId: string
  modelLabel: string
}

// Flatten the provider catalog into one option per model. A failed list result
// (or a missing one, when the IPC is unavailable) yields no rows rather than a
// fabricated entry — the caller renders an unavailable state instead.
export function buildConversationSpawnOptions(
  result: ConversationProviderListResult | null | undefined,
): ConversationSpawnOption[] {
  if (!result || !result.ok) return []
  return result.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      providerLabel: provider.displayName,
      modelId: model.id,
      modelLabel: model.displayName ?? model.id,
    })),
  )
}

// The agent-state fields that make a fresh agent a conversation-runtime agent.
// Shared by the spawn action and its test so the routing contract cannot drift:
// `runtimeKind`/`conversation` opt into AgentChatView, and the `cli*` fields are
// cleared so no terminal session is ever started for this agent.
export function conversationAgentRuntimePatch(
  providerId: string,
  modelId: string,
): Partial<AgentState> {
  return {
    kind: 'general',
    specialistId: undefined,
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

// Pick the option a new Conversation agent should open with: the remembered
// provider/model pair when it is still installed, otherwise the first available
// option. Returns null when there are no options (no providers / not loaded), so
// the caller can hide or disable the spawn entry.
export function resolveDefaultConversationOption(
  options: ConversationSpawnOption[],
  remembered: AgentConversationRuntime | null | undefined,
  dynamicProviderIds?: ReadonlySet<string>,
): ConversationSpawnOption | null {
  if (options.length === 0) return null
  if (remembered) {
    const match = options.find(
      (option) => option.providerId === remembered.providerId && option.modelId === remembered.modelId,
    )
    if (match) return match
    // Dynamic providers (e.g. OpenRouter) accept any model id from their live
    // catalog, so a remembered model that is not in the static seed list is still
    // valid — synthesize an option from the provider's label so "remember last
    // used" works for live-only models.
    if (dynamicProviderIds?.has(remembered.providerId)) {
      const providerLabel = options.find((option) => option.providerId === remembered.providerId)?.providerLabel
      if (providerLabel) {
        return {
          providerId: remembered.providerId,
          providerLabel,
          modelId: remembered.modelId,
          modelLabel: remembered.modelId,
        }
      }
    }
  }
  return options[0]
}
