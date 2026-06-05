// providerSettings — pure, DOM-free derivation logic for the Settings ->
// Providers tab (T3, plugin-driven conversation runtime). The React component
// (`ProviderSettingsTab.tsx`) owns IPC calls and rendering; everything that can
// be unit-tested without a renderer lives here so the lifecycle states
// (loading / empty / unavailable / configured / missing-key / readiness check)
// have node-level coverage like `cliRuntimeOptions.ts`.
//
// Boundary note: provider listing and secret status come from the conversation
// IPC surface delivered in T1/T2 (`conversation:providers:list`,
// `conversation:secrets:{status,set,clear}`). A live endpoint handshake and the
// typed `conversation:providers:test` contract are owned by T7 (the real
// OpenAI-compatible provider task); the readiness verdict below is an honest
// credential/auth check over `conversation:secrets:status`, never a fabricated
// "connected" success.

import type {
  ConversationProviderListEntry,
  ConversationProviderModel,
  ConversationProviderType,
} from '../../../../shared/plugin-manifest'
import type {
  ConversationProviderListResult,
  ConversationSecretStatus,
  ConversationSecretStatusResult,
} from '../../../../shared/electron-api'
import type { Tone } from '../ui'

export type { ConversationProviderListEntry }

// Stable fragment of the main-process message returned when a provider declares
// no `auth` block (see `secret-store.ts` `resolveDescriptor`). Matching it lets
// us distinguish "this provider needs no key" from a genuine status failure.
const NO_SECRET_DECLARED_FRAGMENT = 'does not declare a secret'

/** Top-level state of the Providers tab, derived from the list IPC result. */
export type ProviderTabState =
  // The running build predates the conversation IPC (older preload). Mirrors the
  // MCP/skill-pack tabs' "needs a restart" degradation.
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

/** A non-color-only status descriptor (dot tone + text) for a provider row. */
export type ProviderStatusSummary = {
  tone: Tone
  label: string
}

export type ProviderAdapterSummary = {
  tone: Tone
  label: string
  detail?: string
}

/**
 * Credential-readiness verdict for the "Check key status" action. There is no
 * live network handshake here (that lands with the first real provider
 * integration, T7), so this reports stored-credential readiness honestly rather
 * than claiming the remote endpoint answered.
 */
export type ProviderReadiness = {
  tone: Tone
  headline: string
  detail: string
}

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

export function summarizeProviderSecret(view: ProviderSecretView | undefined): ProviderStatusSummary {
  if (!view) return { tone: 'neutral', label: 'Checking key status' }
  switch (view.kind) {
    case 'none-required':
      return { tone: 'neutral', label: 'No API key required' }
    case 'missing':
      return { tone: 'warn', label: 'API key needed' }
    case 'configured':
      if (view.source === 'environment') return { tone: 'good', label: 'Using environment key' }
      if (view.persistence === 'session') return { tone: 'warn', label: 'Session-only key' }
      return { tone: 'good', label: 'Key configured' }
    case 'error':
      return { tone: 'error', label: 'Key status unavailable' }
  }
}

export function summarizeProviderAdapter(provider: ConversationProviderListEntry): ProviderAdapterSummary {
  const adapter = provider.adapter
  if (adapter.execution === 'blocked') {
    return {
      tone: 'error',
      label: 'Adapter blocked',
      detail: adapter.trustError ?? 'Executable provider adapter is not trusted for execution.',
    }
  }
  if (adapter.execution === 'executable') {
    return { tone: 'good', label: 'Trusted adapter' }
  }
  return { tone: 'neutral', label: 'Declarative provider' }
}

export function deriveProviderReadiness(view: ProviderSecretView | undefined): ProviderReadiness {
  if (!view) {
    return { tone: 'neutral', headline: 'Status unknown', detail: 'Provider status has not been checked yet.' }
  }
  switch (view.kind) {
    case 'none-required':
      return {
        tone: 'good',
        headline: 'No key required',
        detail: 'This provider authenticates without a stored API key.',
      }
    case 'missing':
      return {
        tone: 'error',
        headline: 'No API key',
        detail: 'Add an API key before this provider can be used.',
      }
    case 'configured':
      if (view.source === 'environment') {
        return {
          tone: 'good',
          headline: 'Credentials ready',
          detail: 'Using an API key from the environment. The value is never read back into the app.',
        }
      }
      if (view.persistence === 'session') {
        return {
          tone: 'warn',
          headline: 'Stored for this session only',
          detail: 'OS encryption is unavailable, so the key clears when Multicode quits.',
        }
      }
      return {
        tone: 'good',
        headline: 'Credentials ready',
        detail: 'API key is stored and encrypted on this device.',
      }
    case 'error':
      return { tone: 'error', headline: 'Status unavailable', detail: view.message }
  }
}

export function canClearProviderSecret(view: ProviderSecretView | undefined): boolean {
  // Only a key this app stored (settings/session) is clearable. Environment
  // keys and no-auth providers expose nothing to clear from the renderer.
  if (!view || view.kind !== 'configured') return false
  return view.source === 'settings' || view.source === 'session'
}

export function formatProviderType(type: ConversationProviderType): string {
  return type === 'agent-harness' ? 'Agent harness' : 'Model provider'
}

export function formatProviderSource(source: ConversationProviderListEntry['source']): string {
  return source === 'bundled' ? 'Built-in' : 'User provider'
}

export function modelDisplayName(model: ConversationProviderModel): string {
  return model.displayName?.trim() || model.id
}

export function formatProviderModels(models: ConversationProviderModel[]): string {
  if (models.length === 0) return 'No models declared'
  const names = models.map(modelDisplayName)
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
}
