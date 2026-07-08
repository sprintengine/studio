import type { ConversationProviderListResult } from '../../../../shared/electron-api'
import type { ConversationProviderType } from '../../../../shared/plugin-manifest'
import type { AgentConversationRuntime, AgentState } from '../../types/workspace'

// One selectable spawn row in the agent menu: a single provider/model pair the
// user can launch as a conversation-backed agent. Provider and model ids are
// passed straight to `addNewConversationAgent`, so they must be preserved
// exactly as the provider catalog returned them — labels are display-only.
// `providerType` distinguishes the user's own subscription CLI
// ('agent-harness') from metered API providers ('model-provider');
// `unavailable` carries the provider's reason it cannot start sessions.
export type ConversationSpawnOption = {
  providerId: string
  providerLabel: string
  providerType: ConversationProviderType
  modelId: string
  modelLabel: string
  unavailable?: string
}

// Flatten the provider catalog into one option per model. A failed list result
// (or a missing one, when the IPC is unavailable) yields no rows rather than a
// fabricated entry — the caller renders an unavailable state instead.
// Unavailable providers keep their rows (marked) so default resolution can see
// them — a spawn default must distinguish "no subscription installed" from
// "subscription installed but its CLI is currently undetectable".
export function buildConversationSpawnOptions(
  result: ConversationProviderListResult | null | undefined,
): ConversationSpawnOption[] {
  if (!result || !result.ok) return []
  return result.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      providerLabel: provider.displayName,
      providerType: provider.providerType,
      modelId: model.id,
      modelLabel: model.displayName ?? model.id,
      ...(provider.unavailable ? { unavailable: provider.unavailable } : {}),
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

// Pick the option a new Conversation agent should open with. Subscription
// first: when an agent-harness provider (the user's own Claude subscription)
// is installed, new conversations default to it — a metered API provider is
// never a silent default, only an explicit per-conversation pick. The
// remembered provider/model pair is honored within the harness (e.g. Sonnet
// vs Opus); with no harness installed it falls back to the previous
// remembered-then-first behavior. Returns null when there are no options (no
// providers / not loaded), so the caller can hide or disable the spawn entry.
export function resolveDefaultConversationOption(
  options: ConversationSpawnOption[],
  remembered: AgentConversationRuntime | null | undefined,
  dynamicProviderIds?: ReadonlySet<string>,
): ConversationSpawnOption | null {
  if (options.length === 0) return null
  const harnessOptions = options.filter((option) => option.providerType === 'agent-harness')
  if (harnessOptions.length > 0) {
    // Fail closed, never open: when the subscription harness is installed but
    // currently unavailable (CLI undetectable), a spawn default must NOT fall
    // through to a metered provider — returning null hides the spawn entry
    // and the picker explains why the harness is unavailable.
    const availableHarness = harnessOptions.filter((option) => !option.unavailable)
    if (availableHarness.length === 0) return null
    const rememberedHarness = remembered
      ? availableHarness.find(
          (option) => option.providerId === remembered.providerId && option.modelId === remembered.modelId,
        )
      : undefined
    return rememberedHarness ?? availableHarness[0] ?? null
  }
  const availableOptions = options.filter((option) => !option.unavailable)
  if (availableOptions.length === 0) return null
  if (remembered) {
    const match = availableOptions.find(
      (option) => option.providerId === remembered.providerId && option.modelId === remembered.modelId,
    )
    if (match) return match
    // Dynamic providers (e.g. OpenRouter) accept any model id from their live
    // catalog, so a remembered model that is not in the static seed list is still
    // valid — synthesize an option from the provider's label so "remember last
    // used" works for live-only models.
    if (dynamicProviderIds?.has(remembered.providerId)) {
      const rememberedProvider = availableOptions.find((option) => option.providerId === remembered.providerId)
      if (rememberedProvider) {
        return {
          providerId: remembered.providerId,
          providerLabel: rememberedProvider.providerLabel,
          providerType: rememberedProvider.providerType,
          modelId: remembered.modelId,
          modelLabel: remembered.modelId,
        }
      }
    }
  }
  return availableOptions[0] ?? null
}
