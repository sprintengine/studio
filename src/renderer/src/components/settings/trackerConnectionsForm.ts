// Pure logic for the Trackers settings surface (T2 / MC-1633 UI, mockup §1).
// Kept free of React and Electron so it unit-tests as a plain node module and so
// the add-form's field visibility is driven by a DATA TABLE keyed on provider —
// never a hardcoded `if (provider === …)` branch in the component. The single
// per-provider difference the mockup shows (GitHub/Jira carry a server address,
// Linear does not; Jira offers a Cloud-vs-Data-Center credential choice) falls
// out of `selfHostable` + the `authModes` list here, mirroring the T1
// TrackerCapabilities the provider clients (T3/T4/T5) declare.

import type {
  RedactedTrackerConnection,
  TrackerAddConnectionInput,
  TrackerAuthMode,
  TrackerConnectionDraft,
  TrackerConnectionStatus,
  TrackerProviderId,
} from '../../../../shared/electron-api'
import type { Tone } from '../ui/tokens'

// How a connection on a given auth mode is credentialed. `selfHosted` marks the
// "Self-hosted · …" prefix in the connection-list credential cell:
//   - true    → always self-hosted (Jira Data Center PAT)
//   - false   → always cloud (Jira Cloud Basic, Linear key)
//   - 'byHost'→ self-hosted only when the server address is a non-default host
//               (GitHub Enterprise Server vs github.com)
export type TrackerAuthModeSpec = {
  value: TrackerAuthMode
  // Shown in the "Where does this run?" chooser when a provider has >1 mode.
  choiceLabel: string
  // Credential field label; follows the selected mode (mockup: "Personal access
  // token" for GitHub, "API key" for Linear, and the Jira modes).
  tokenLabel: string
  // Format/storage guidance under the credential field.
  tokenHelp: string
  // Lowercase noun for the connection-list credential cell ("personal access
  // token", "email and API token", "API key").
  credentialNoun: string
  selfHosted: boolean | 'byHost'
}

export type TrackerServerFieldSpec = {
  label: string
  help: string
  // Prefilled when the provider is selected; '' when there is no sensible
  // default (Jira, where the site/server URL is always user-supplied).
  defaultValue: string
  placeholder: string
  // Rendered as the host in a connection row when the stored baseUrl is blank
  // (GitHub github.com default).
  defaultHostLabel: string
}

export type TrackerProviderFormSpec = {
  id: TrackerProviderId
  label: string
  // Two-letter mark shown in the segmented control and connection rows.
  monogram: string
  // Drives the server-address field's visibility (mirrors T1
  // TrackerCapabilities.selfHostable). false ⇒ no server field (Linear).
  selfHostable: boolean
  // Present iff `selfHostable`; the server-address field descriptor.
  server: TrackerServerFieldSpec | null
  // Shown in place of the server field when the provider is cloud-only.
  cloudOnlyNote?: string
  // 1 entry ⇒ no chooser; >1 ⇒ the Cloud-vs-Data-Center Select (Jira).
  authModes: TrackerAuthModeSpec[]
  // Host label for a connection row when baseUrl is null (Linear).
  cloudHostLabel: string
}

const STORAGE_HELP = 'Stored encrypted on this machine. It only ever leaves to reach your tracker.'

// The provider form table. Ordered as the segmented control renders them.
export const TRACKER_PROVIDER_FORM_SPECS: readonly TrackerProviderFormSpec[] = [
  {
    id: 'github',
    label: 'GitHub',
    monogram: 'GH',
    selfHostable: true,
    server: {
      label: 'Server address',
      help: 'Leave as github.com, or enter your GitHub Enterprise Server host.',
      defaultValue: 'github.com',
      placeholder: 'github.com',
      defaultHostLabel: 'github.com',
    },
    cloudHostLabel: 'github.com',
    authModes: [
      {
        value: 'github_pat',
        choiceLabel: 'Personal access token',
        tokenLabel: 'Personal access token',
        tokenHelp: STORAGE_HELP,
        credentialNoun: 'personal access token',
        selfHosted: 'byHost',
      },
    ],
  },
  {
    id: 'jira',
    label: 'Jira',
    monogram: 'J',
    selfHostable: true,
    server: {
      label: 'Jira server address',
      help: 'Your Jira Cloud site or self-hosted server address.',
      defaultValue: '',
      placeholder: 'https://your-company.atlassian.net',
      defaultHostLabel: '',
    },
    cloudHostLabel: '',
    authModes: [
      {
        value: 'jira_basic',
        choiceLabel: 'Jira Cloud — email and API token',
        tokenLabel: 'Email and API token',
        tokenHelp:
          'Enter your Jira account email and API token together as email:token — for example you@acme.com:abc123. ' +
          STORAGE_HELP,
        credentialNoun: 'email and API token',
        selfHosted: false,
      },
      {
        value: 'jira_pat',
        choiceLabel: 'Self-hosted (Data Center) — personal access token',
        tokenLabel: 'Personal access token',
        tokenHelp: STORAGE_HELP,
        credentialNoun: 'personal access token',
        selfHosted: true,
      },
    ],
  },
  {
    id: 'linear',
    label: 'Linear',
    monogram: 'L',
    selfHostable: false,
    server: null,
    cloudOnlyNote:
      'Linear runs only as a cloud service — no server address needed. Self-hosted servers are supported for Jira and GitHub.',
    cloudHostLabel: 'linear.app',
    authModes: [
      {
        value: 'linear_key',
        choiceLabel: 'API key',
        tokenLabel: 'API key',
        tokenHelp: 'Create a personal API key in Linear settings. ' + STORAGE_HELP,
        credentialNoun: 'API key',
        selfHosted: false,
      },
    ],
  },
]

export function trackerProviderFormSpec(provider: TrackerProviderId): TrackerProviderFormSpec {
  const spec = TRACKER_PROVIDER_FORM_SPECS.find((entry) => entry.id === provider)
  if (!spec) throw new Error(`Unknown tracker provider: ${provider}`)
  return spec
}

// The draft the add form edits. `baseUrl` is always a string here (the field's
// live value); it is normalized to null for cloud-only providers on submit.
export type TrackerConnectionFormDraft = {
  provider: TrackerProviderId
  baseUrl: string
  authMode: TrackerAuthMode
  label: string
  secret: string
}

export function defaultDraftForProvider(provider: TrackerProviderId): TrackerConnectionFormDraft {
  const spec = trackerProviderFormSpec(provider)
  return {
    provider,
    baseUrl: spec.server?.defaultValue ?? '',
    authMode: spec.authModes[0].value,
    label: '',
    secret: '',
  }
}

export function activeAuthModeSpec(draft: TrackerConnectionFormDraft): TrackerAuthModeSpec {
  const spec = trackerProviderFormSpec(draft.provider)
  return spec.authModes.find((mode) => mode.value === draft.authMode) ?? spec.authModes[0]
}

// A provider only shows the Cloud-vs-Data-Center chooser when it carries more
// than one credential mode.
export function providerHasAuthModeChoice(provider: TrackerProviderId): boolean {
  return trackerProviderFormSpec(provider).authModes.length > 1
}

// Normalizes the editable draft into the write-only IPC input. baseUrl collapses
// to null for cloud-only providers (Linear); everything else is trimmed.
export function draftToAddConnectionInput(draft: TrackerConnectionFormDraft): TrackerAddConnectionInput {
  const spec = trackerProviderFormSpec(draft.provider)
  const trimmedHost = draft.baseUrl.trim()
  return {
    provider: draft.provider,
    baseUrl: spec.selfHostable ? (trimmedHost ? trimmedHost : null) : null,
    authMode: draft.authMode,
    label: draft.label.trim(),
    secret: draft.secret,
  }
}

export function draftToTestConnectionDraft(draft: TrackerConnectionFormDraft): TrackerConnectionDraft {
  return draftToAddConnectionInput(draft)
}

// A connection cannot be tested until every required field is present: a name, a
// credential, and — for a self-hostable provider — a server address. Returns the
// reason a test is blocked, or null when the draft is testable.
export function draftBlockedReason(draft: TrackerConnectionFormDraft): string | null {
  const spec = trackerProviderFormSpec(draft.provider)
  if (!draft.label.trim()) return 'Add a name for this connection.'
  if (spec.selfHostable && !draft.baseUrl.trim()) return `Add the ${spec.server?.label.toLowerCase() ?? 'server address'}.`
  if (!draft.secret.trim()) return `Add the ${activeAuthModeSpec(draft).tokenLabel.toLowerCase()}.`
  return null
}

export function canTestDraft(draft: TrackerConnectionFormDraft): boolean {
  return draftBlockedReason(draft) === null
}

// Stable identity of a draft's testable content. When the user edits any field
// that changes the credential round-trip, this key changes, so a prior "test
// passed" result no longer authorizes Add.
export function draftTestKey(draft: TrackerConnectionFormDraft): string {
  const input = draftToAddConnectionInput(draft)
  return JSON.stringify([input.provider, input.baseUrl, input.authMode, input.label.trim(), draft.secret])
}

// ---------------------------------------------------------------------------
// Connection-list presentation (redacted connections crossing from T1 IPC).
// ---------------------------------------------------------------------------

export type TrackerConnectionStatusView = {
  tone: Tone
  // Short chip label.
  label: string
  // Provider's own reason, shown as muted text for non-connected states so an
  // `unknown` never reads as a bare/empty state (mockup: "unknown-with-reason").
  reason?: string
  // The recovery action offered in the row's trailing slot. Both re-probe the
  // connection through tracker:testConnection; the verb matches the state.
  recovery: 'none' | 'reconnect' | 'test'
}

const STATUS_VIEW: Record<TrackerConnectionStatus, Omit<TrackerConnectionStatusView, 'reason'>> = {
  connected: { tone: 'good', label: 'Connected', recovery: 'none' },
  expired: { tone: 'warn', label: 'Token expired', recovery: 'reconnect' },
  unknown: { tone: 'neutral', label: 'Not checked', recovery: 'test' },
}

export function connectionStatusView(connection: RedactedTrackerConnection): TrackerConnectionStatusView {
  const base = STATUS_VIEW[connection.status]
  return connection.status === 'connected'
    ? base
    : { ...base, ...(connection.statusReason ? { reason: connection.statusReason } : {}) }
}

// Whether a connection resolves to a self-hosted instance, per its auth mode
// (and, for GitHub, its host). Drives the "Self-hosted · …" credential prefix.
export function connectionIsSelfHosted(connection: RedactedTrackerConnection): boolean {
  const spec = trackerProviderFormSpec(connection.provider)
  const mode = spec.authModes.find((m) => m.value === connection.authMode)
  if (!mode) return false
  if (mode.selfHosted === 'byHost') {
    const host = connection.baseUrl?.trim().toLowerCase()
    const defaultHost = spec.server?.defaultHostLabel.toLowerCase()
    return Boolean(host) && host !== defaultHost
  }
  return mode.selfHosted
}

// The connection-list "credential kind" cell, e.g. "Personal access token",
// "Self-hosted · personal access token", "API key".
export function connectionCredentialKind(connection: RedactedTrackerConnection): string {
  const spec = trackerProviderFormSpec(connection.provider)
  const mode = spec.authModes.find((m) => m.value === connection.authMode)
  const noun = mode?.credentialNoun ?? 'credential'
  const label = connectionIsSelfHosted(connection) ? `Self-hosted · ${noun}` : noun
  return label.charAt(0).toUpperCase() + label.slice(1)
}

// The host shown in a connection row: the stored server address, or the
// provider's default/cloud host label when none is stored.
export function connectionHostLabel(connection: RedactedTrackerConnection): string {
  const host = connection.baseUrl?.trim()
  if (host) return host
  const spec = trackerProviderFormSpec(connection.provider)
  return spec.selfHostable ? spec.server?.defaultHostLabel || spec.cloudHostLabel : spec.cloudHostLabel
}

export function trackerProviderMonogram(provider: TrackerProviderId): string {
  return trackerProviderFormSpec(provider).monogram
}
