import type { ConversationProviderListEntry, ConversationProviderModel } from '../../../../../shared/plugin-manifest'

// One provider's models as this view reads them for the current model's label
// and context length.
export type ModelGroup = {
  providerId: string
  providerLabel: string
  // Native CLI credentials and app-managed API keys remain visibly distinct;
  // neither native login nor a tool capability implies a subscription plan.
  credentialSource?: 'native' | 'api-key' | 'none'
  // Plain-language reason the provider cannot start sessions.
  unavailable?: string
  models: ConversationProviderModel[]
  // Explicit empty state for a dynamic-catalog provider with no models to list:
  // 'add-key' — no key configured; 'no-models' — key present but the live
  // catalog came back empty.
  emptyState?: 'add-key' | 'no-models'
}

// Model groups: one per provider, merging each provider's own live catalog
// (fetched when the user browses to it) over its manifest seed. Native-login
// providers sort first and identify their CLI-owned credentials, so app-managed
// API keys are never mistaken for the user's existing native configuration. A
// dynamic-catalog provider is never dropped for an empty seed: when its key is
// missing it shows an explicit add-key state, and when the key is present but
// the catalog is empty it says so — never a silent stale seed.
export function buildModelGroups(
  providers: ConversationProviderListEntry[],
  catalogByProvider: Record<string, ConversationProviderModel[]>,
  keyByProvider: Record<string, boolean>,
): ModelGroup[] {
  return [...providers]
    .sort((a, b) => Number(b.credentialSource === 'native') - Number(a.credentialSource === 'native'))
    .map((entry): ModelGroup => {
      const base = {
        providerId: entry.id,
        providerLabel: entry.displayName,
        unavailable: entry.unavailable,
        credentialSource: entry.credentialSource,
      }
      const liveCatalog = catalogByProvider[entry.id]
      const hasLive = Array.isArray(liveCatalog) && liveCatalog.length > 0
      // Native providers need no app-managed key: live catalog if it
      // loaded, else the seed. Static model-providers list their full seed as-is
      // — it is the complete catalog, not a truncated one.
      if (entry.credentialSource === 'native' || !entry.supportsDynamicModels) {
        return {
          ...base,
          models: hasLive ? liveCatalog : entry.models,
        }
      }
      // Dynamic model-providers (OpenRouter, xAI): key state gates the catalog.
      const hasKey = entry.credentialSource === 'none' ? true : keyByProvider[entry.id]
      if (hasKey === false) return { ...base, models: [], emptyState: 'add-key' }
      if (hasLive) return { ...base, models: liveCatalog }
      // Key present but catalog empty/unreachable: say so rather than seed.
      if (hasKey === true) return { ...base, models: [], emptyState: 'no-models' }
      // Key state not yet fetched — show the seed provisionally until the user
      // browses to this provider and its live catalog + key status load.
      return { ...base, models: entry.models }
    })
}
