// installFlow — pure, DOM-free derivation for the Settings → Extensions → Browse
// trust-gate install flow. The React component (`BrowseStorefront.tsx`) owns the
// verify/install IPC calls and rendering; the state machine, classification, and
// per-state presentation live here so every state (idle / verifying / needs-trust
// / installing / installed / blocked / error) gets node-level coverage like the
// other settings view-models.
//
// Phase-3 contract (architect ruling, 2026-06-16): the trust prompt must disclose
// the REAL requested permissions BEFORE trust is granted. Those live only in the
// signed plugin.json (the registry index omits them — T2.2 ruling), so they are
// sourced from the T3.4 `verifyMarketplacePlugin` IPC, which runs the existing
// download + ed25519-verify path WITHOUT installing. Flow: idle → click Install →
// verifying → if 'verified' install directly; if 'community' show the trust prompt
// populated with the verified permissions, then install with trustGranted:true;
// if 'unsigned' OR 'invalid', a hard block with no install affordance (only signed
// community plugins get the trust prompt). No permission is ever fabricated.

import type {
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginVerifyResult,
} from '../../../../shared/electron-api'
import type { CapabilityPermission } from '../../../../shared/modules/permissions'

// The blocked classifications: signature problems that offer no install path.
// 'community' is NOT here — it is trust-grantable; 'verified' installs directly.
export type BlockedClassification = 'unsigned' | 'invalid'

export type InstallFlowState =
  | { status: 'idle' }
  // verifyMarketplacePlugin in flight (download + ed25519-verify, no install).
  | { status: 'verifying' }
  // Signed community plugin: show the trust prompt with the verified permissions.
  | { status: 'needs-trust'; permissions: CapabilityPermission[] }
  // install-entry IPC in flight (verified direct, or community after trust).
  | { status: 'installing' }
  | { status: 'installed'; updated: boolean }
  // Hard block (unsigned/invalid): no install affordance is offered.
  | { status: 'blocked'; classification: BlockedClassification; message: string; issues?: string[] }
  // Verify or install failed reachably (network / thrown / install ok:false) —
  // distinct from a hard block: the user may retry.
  | { status: 'error'; message: string; issues?: string[] }

// What the component should do next once verify resolves.
export type VerifyOutcome =
  | { kind: 'install' } // verified → install directly, no trust prompt
  | { kind: 'needs-trust'; permissions: CapabilityPermission[] } // community → trust prompt
  | { kind: 'blocked'; classification: BlockedClassification; message: string; issues?: string[] }

function blockedFallbackMessage(classification: BlockedClassification): string {
  return classification === 'invalid'
    ? "This extension's signature is invalid, so it can't be installed."
    : "This extension is unsigned, so it can't be installed."
}

// Map a verify result to the next step. Verified installs directly; community
// earns the trust prompt with its real verified permissions; unsigned/invalid
// are hard blocks carrying the verifier's message + issue detail.
export function classifyVerification(verify: MarketplacePluginVerifyResult): VerifyOutcome {
  switch (verify.classification) {
    case 'verified':
      return { kind: 'install' }
    case 'community':
      return { kind: 'needs-trust', permissions: verify.permissions }
    case 'unsigned':
    case 'invalid':
      return {
        kind: 'blocked',
        classification: verify.classification,
        message: verify.message || blockedFallbackMessage(verify.classification),
        issues: verify.issues?.map((issue) => issue.message),
      }
  }
}

// Map an install-entry result to a terminal flow state. A successful install is
// `installed` (carrying whether it replaced a prior version); any failure is
// `error` with the lifecycle's message + issue detail (never a fake success).
export function summarizeInstallResult(result: MarketplacePluginRegistryInstallResult): InstallFlowState {
  if (result.ok) return { status: 'installed', updated: result.updated }
  return {
    status: 'error',
    message: result.message || 'The install could not be completed.',
    issues: result.issues?.map((issue) => issue.message),
  }
}

// --- presentation ----------------------------------------------------------

export type InstallActionKind = 'install' | 'trust-install' | 'retry'
export type NoticeTone = 'good' | 'warn' | 'error'

export type InstallFlowView = {
  // The primary action button, or null when no action is offered (verifying /
  // installing / installed / blocked).
  action: { kind: InstallActionKind; label: string } | null
  // A spinner/progress state: interactions are suppressed and `busyLabel` shows.
  busy: boolean
  busyLabel?: string
  // The trust prompt: render the permission disclosure + an explicit Cancel
  // alongside the trust-install action. Only the 'needs-trust' state sets this.
  trustPrompt: boolean
  // Real verified permissions to disclose at the trust prompt — never
  // fabricated. `null` outside the trust prompt; `[]` is a real "no access" list.
  permissions: CapabilityPermission[] | null
  // An explanatory notice (success / blocked / error). Status is carried by the
  // message text + tone, never colour alone.
  notice: { tone: NoticeTone; message: string; issues?: string[] } | null
}

export function deriveInstallView(state: InstallFlowState): InstallFlowView {
  switch (state.status) {
    case 'idle':
      return { action: { kind: 'install', label: 'Install' }, busy: false, trustPrompt: false, permissions: null, notice: null }
    case 'verifying':
      return { action: null, busy: true, busyLabel: 'Verifying…', trustPrompt: false, permissions: null, notice: null }
    case 'needs-trust':
      return {
        action: { kind: 'trust-install', label: 'Trust and install' },
        busy: false,
        trustPrompt: true,
        permissions: state.permissions,
        notice: null,
      }
    case 'installing':
      return { action: null, busy: true, busyLabel: 'Installing…', trustPrompt: false, permissions: null, notice: null }
    case 'installed':
      return {
        action: null,
        busy: false,
        trustPrompt: false,
        permissions: null,
        notice: { tone: 'good', message: state.updated ? 'Updated to the latest version.' : 'Installed.' },
      }
    case 'blocked':
      // No install affordance (action: null). Invalid is an error tone; unsigned
      // is a warn tone — both still block, and the message carries the reason.
      return {
        action: null,
        busy: false,
        trustPrompt: false,
        permissions: null,
        notice: {
          tone: state.classification === 'invalid' ? 'error' : 'warn',
          message: state.message,
          issues: state.issues,
        },
      }
    case 'error':
      return {
        action: { kind: 'retry', label: 'Try again' },
        busy: false,
        trustPrompt: false,
        permissions: null,
        notice: { tone: 'error', message: state.message, issues: state.issues },
      }
  }
}
