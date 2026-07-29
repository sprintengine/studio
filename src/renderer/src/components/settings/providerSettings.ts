// providerSettings — pure, DOM-free derivation logic for the Settings ->
// Providers tab (plugin-driven conversation runtime). The React component
// (`ProviderSettingsTab.tsx`) owns IPC calls and rendering; everything that can
// be unit-tested without a renderer lives here so the lifecycle states
// (loading / empty / unavailable / configured / missing-key) have node-level
// coverage like `cliRuntimeOptions.ts`.
//
// Boundary note: provider listing and secret status come from the conversation
// IPC surface (`conversation:providers:list`, `conversation:secrets:{status,
// set,clear}`). The renderer never reads a saved key back — secret status only
// reports whether a key is present and where it came from.

import type { ConversationProviderListEntry } from '../../../../shared/plugin-manifest'
import type {
  ConversationProviderListResult,
  ConversationSecretStatus,
  ConversationSecretStatusResult,
} from '../../../../shared/electron-api'

export type { ConversationProviderListEntry }

// Stable fragment of the main-process message returned when a provider declares
// no `auth` block (see `secret-store.ts` `resolveDescriptor`). Matching it lets
// us distinguish "this provider needs no key" from a genuine status failure.
const NO_SECRET_DECLARED_FRAGMENT = 'does not declare a secret'

/** Top-level state of the Providers tab, derived from the list IPC result. */
export type ProviderTabState =
  // The running build predates the conversation IPC (older preload). Mirrors the
  // MCP tab's "needs a restart" degradation.
  | { kind: 'unavailable'; message: string }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'ready'; providers: ConversationProviderListEntry[] }

/** Per-provider secret/auth view, derived from a secret-status IPC result. */
export type ProviderSecretView =
  | { kind: 'none-required' }
  | { kind: 'missing'; label: string; encryptionAvailable: boolean }
  | {
      kind: 'configured'
      label: string
      source: ConversationSecretStatus['source']
      persistence: ConversationSecretStatus['persistence']
      encryptionAvailable: boolean
    }
  | { kind: 'error'; message: string }

export function deriveProviderTabState(
  result: ConversationProviderListResult | null,
  ipcAvailable: boolean
): ProviderTabState {
  if (!ipcAvailable) {
    return {
      kind: 'unavailable',
      message: 'Conversation providers need an app restart before this tab is available.',
    }
  }
  if (result === null) return { kind: 'loading' }
  if (!result.ok) {
    return { kind: 'error', message: result.message || 'Conversation providers are unavailable.' }
  }
  if (result.providers.length === 0) return { kind: 'empty' }
  return { kind: 'ready', providers: orderProviders(result.providers) }
}

// Bundled providers first, then user providers, each group alphabetical by
// display name — same ordering intent as the installed-plugin (Agents) table.
export function orderProviders(
  providers: ConversationProviderListEntry[]
): ConversationProviderListEntry[] {
  const sourceRank = (source: ConversationProviderListEntry['source']): number =>
    source === 'bundled' ? 0 : 1
  return [...providers].sort((a, b) => {
    const rank = sourceRank(a.source) - sourceRank(b.source)
    if (rank !== 0) return rank
    return a.displayName.localeCompare(b.displayName)
  })
}

export function deriveProviderSecretView(
  result: ConversationSecretStatusResult
): ProviderSecretView {
  if (!result.ok) {
    if (result.message.toLowerCase().includes(NO_SECRET_DECLARED_FRAGMENT)) {
      return { kind: 'none-required' }
    }
    return { kind: 'error', message: result.message }
  }
  const status = result.status
  if (!status.configured) {
    return { kind: 'missing', label: status.label, encryptionAvailable: status.encryptionAvailable }
  }
  return {
    kind: 'configured',
    label: status.label,
    source: status.source,
    persistence: status.persistence,
    encryptionAvailable: status.encryptionAvailable,
  }
}

export function canClearProviderSecret(view: ProviderSecretView | undefined): boolean {
  // Only a key this app stored (settings/session) is clearable. Environment
  // keys and no-auth providers expose nothing to clear from the renderer.
  if (!view || view.kind !== 'configured') return false
  return view.source === 'settings' || view.source === 'session'
}
