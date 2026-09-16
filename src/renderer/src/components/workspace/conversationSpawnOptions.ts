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

// One conversation PROVIDER as the spawn picker lists it (MC-2122): the rail's
// conversation entry shows providers, not the cross-product of every model, and
// the model stays switchable in the chat composer until the first message.
export type ConversationProviderRow = {
  providerId: string
  providerLabel: string
  modelId: string
  modelLabel: string
}

/**
 * Collapse the option list to one row per provider that can actually start a
 * session, in catalog order. Each row opens on the remembered model when that
 * model belongs to the provider, else on the provider's first model.
 *
 * Unavailable providers are dropped rather than shown disabled: a row that
 * cannot spawn is not a way in. A metered provider still appears here even when
 * the subscription harness is unavailable — the fail-closed rule in
 * `resolveDefaultConversationOption` is about never making metered the SILENT
 * default, and a row the user clicks is an explicit pick.
 */
export function buildConversationProviderRows(
  options: ConversationSpawnOption[],
  remembered: AgentConversationRuntime | null | undefined,
): ConversationProviderRow[] {
  const rows: ConversationProviderRow[] = []
  const seen = new Set<string>()
  for (const option of options) {
    if (option.unavailable) continue
    if (seen.has(option.providerId)) continue
    seen.add(option.providerId)
    const forProvider = options.filter(
      (entry) => entry.providerId === option.providerId && !entry.unavailable,
    )
    const rememberedModel =
      remembered && remembered.providerId === option.providerId
        ? forProvider.find((entry) => entry.modelId === remembered.modelId)
        : undefined
    const opening = rememberedModel ?? option
    rows.push({
      providerId: opening.providerId,
      providerLabel: opening.providerLabel,
      modelId: opening.modelId,
      modelLabel: opening.modelLabel,
    })
  }
  return rows
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
