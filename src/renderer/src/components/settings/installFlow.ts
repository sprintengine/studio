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
// populated with the verified permissions, then install with trustGranted:true.
//
// Trust split (T4b/T5): an 'unsigned' bundle is no longer a blanket block. Unsigned
// mcp/skills-only bundles are declarative — they earn the same explicit trust prompt
// as community (installing load-ineligible behind trustGranted:true). Unsigned
// code-bearing bundles (module/cli) and 'invalid' still hard-block with no install
// affordance, mirroring the backend gate (shared/marketplace/component-trust.ts,
// which is the real enforcement; this classification only picks the UI affordance).
// No permission is ever fabricated.

import type {
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginVerifyResult,
} from '../../../../shared/electron-api'
import type { MarketplaceComponentKind } from '../../../../shared/marketplace/manifest'
import type { CapabilityPermission } from '../../../../shared/modules/permissions'

// Code-bearing kinds execute arbitrary code once loaded, so an UNSIGNED bundle
// carrying one is never trust-grantable in the UI — it hard-blocks. mcp/skills are
// declarative and may install unsigned behind an explicit trust grant. The real
// enforcement is the backend `hasCodeBearingComponent` gate; this kind-level check
// only decides whether the renderer offers a trust prompt or a hard block.
function hasCodeBearingKind(provides: MarketplaceComponentKind[]): boolean {
  return provides.some((kind) => kind === 'module' || kind === 'cli')
}

/**
 * Whether installing this bundle needs an open workspace.
 *
 * Only the two workspace-scoped kinds do: an MCP server syncs into
 * `<workspaceRoot>/.mcp.json` and a skill pack copies into the workspace's
 * harness dirs. A module installs into `~/.sprintengine/modules/<id>`, a CLI
 * plugin into the user plugin root — neither touches a project — so a
 * module-only bundle installs with no workspace open at all, which is what
 * makes a first-party module installable from a fresh app that has never
 * opened a folder (D10). An automation needs one, but an automation-only
 * bundle's own component reports that itself with the sentence that names the
 * project it wants; keeping it out of this gate leaves that message intact.
 *
 * Lives here rather than inline in `BrowseStorefront` so the rule can be
 * asserted without a renderer, like the rest of the flow.
 */
export function installNeedsWorkspace(provides: readonly MarketplaceComponentKind[]): boolean {
  return provides.some((kind) => kind === 'mcp' || kind === 'skills')
}

// The blocked classifications: signature problems that offer no install path.
// 'community' is NOT here — it is trust-grantable; 'verified' installs directly.
type BlockedClassification = 'unsigned' | 'invalid'

export type InstallFlowState =
  | { status: 'idle' }
  // verifyMarketplacePlugin in flight (download + ed25519-verify, no install).
  | { status: 'verifying' }
  // Signed community plugin: show the trust prompt with the verified
  // permissions. `files` carries the real content listing for entries whose
  // payload is files rather than permissions (Claude Code plugin skills).
  | { status: 'needs-trust'; permissions: CapabilityPermission[]; files?: string[]; pinnedRef?: string }
  // install-entry IPC in flight (verified direct, or community after trust).
  | { status: 'installing' }
  // `restartRequired`: the install landed a module whose main entry only loads
  // at app launch (G7/D13), so the notice says so instead of a flat "Installed."
  // that sends the person looking for a door that is not there yet.
  | { status: 'installed'; updated: boolean; notices?: string[]; restartRequired?: boolean }
  // Hard block (unsigned/invalid): no install affordance is offered.
  | { status: 'blocked'; classification: BlockedClassification; message: string; issues?: string[] }
  // Verify or install failed reachably (network / thrown / install ok:false) —
  // distinct from a hard block: the user may retry.
  | { status: 'error'; message: string; issues?: string[] }

// What the component should do next once verify resolves.
export type VerifyOutcome =
  | { kind: 'install' } // verified → install directly, no trust prompt
  | { kind: 'needs-trust'; permissions: CapabilityPermission[]; files?: string[]; pinnedRef?: string } // community → trust prompt
  | { kind: 'blocked'; classification: BlockedClassification; message: string; issues?: string[] }

function blockedFallbackMessage(classification: BlockedClassification): string {
  return classification === 'invalid'
    ? "This extension's signature is invalid, so it can't be installed."
    : "This extension is unsigned, so it can't be installed."
}

// Map a verify result to the next step. Verified installs directly; community and
// unsigned mcp/skills-only earn the trust prompt with the real verified permissions;
// unsigned code-bearing bundles and invalid are hard blocks carrying the verifier's
// message + issue detail. `provides` (from the registry entry) resolves the unsigned
// split — the verify result itself does not carry component kinds.
export function classifyVerification(
  verify: MarketplacePluginVerifyResult,
  provides: MarketplaceComponentKind[],
): VerifyOutcome {
  switch (verify.classification) {
    case 'verified':
      return { kind: 'install' }
    case 'community':
      return {
        kind: 'needs-trust',
        permissions: verify.permissions,
        ...(verify.files?.length ? { files: verify.files } : {}),
        ...(verify.pinnedRef ? { pinnedRef: verify.pinnedRef } : {}),
      }
    case 'unsigned':
      // Code-bearing unsigned hard-blocks (the backend refuses it too); unsigned
      // mcp/skills-only earns the explicit trust prompt with its declared permissions.
      if (hasCodeBearingKind(provides)) {
        return {
          kind: 'blocked',
          classification: 'unsigned',
          message: verify.message || blockedFallbackMessage('unsigned'),
          issues: verify.issues?.map((issue) => issue.message),
        }
      }
      return {
        kind: 'needs-trust',
        permissions: verify.permissions,
        ...(verify.files?.length ? { files: verify.files } : {}),
        ...(verify.pinnedRef ? { pinnedRef: verify.pinnedRef } : {}),
      }
    case 'invalid':
      return {
        kind: 'blocked',
        classification: 'invalid',
        message: verify.message || blockedFallbackMessage('invalid'),
        issues: verify.issues?.map((issue) => issue.message),
      }
  }
}

// Map an install-entry result to a terminal flow state. A successful install is
// `installed` (carrying whether it replaced a prior version). A failure that the
// lifecycle re-classifies as unsigned/invalid at its final download/verify step
// is a hard `blocked` with no retry affordance — the same supply-chain rule as
// preview-time classification (classifyVerification). Any other failure is a
// retryable `error` with the lifecycle's message + issue detail (never a fake
// success).
export function summarizeInstallResult(result: MarketplacePluginRegistryInstallResult): InstallFlowState {
  if (result.ok) {
    return {
      status: 'installed',
      updated: result.updated,
      ...(result.notices?.length ? { notices: result.notices } : {}),
      // Main decides this from LIVE_ENABLED_MODULE_IDS and the components it
      // actually wrote; the renderer keeps no second copy of that list.
      ...(result.restartRequired ? { restartRequired: true } : {}),
    }
  }
  if (result.classification === 'unsigned' || result.classification === 'invalid') {
    return {
      status: 'blocked',
      classification: result.classification,
      message: result.message || blockedFallbackMessage(result.classification),
      issues: result.issues?.map((issue) => issue.message),
    }
  }
  return {
    status: 'error',
    message: result.message || 'The install could not be completed.',
    issues: result.issues?.map((issue) => issue.message),
  }
}

// --- presentation ----------------------------------------------------------

type InstallActionKind = 'install' | 'trust-install' | 'retry'
type NoticeTone = 'good' | 'warn' | 'error'

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
  // Real content listing to disclose at the trust prompt, for Claude Code
  // plugin skill folders; null when the trust decision is permission-shaped.
  files: string[] | null
  // The commit the file listing came from; the trust-install passes it back so
  // the install fetches exactly the disclosed content. Trust prompt only.
  pinnedRef: string | null
  // An explanatory notice (success / blocked / error). Status is carried by the
  // message text + tone, never colour alone.
  notice: { tone: NoticeTone; message: string; issues?: string[] } | null
}

export function deriveInstallView(state: InstallFlowState): InstallFlowView {
  switch (state.status) {
    case 'idle':
      return {
        action: { kind: 'install', label: 'Install' },
        busy: false,
        trustPrompt: false,
        permissions: null,
        files: null,
        pinnedRef: null,
        notice: null,
      }
    case 'verifying':
      return {
        action: null,
        busy: true,
        busyLabel: 'Verifying…',
        trustPrompt: false,
        permissions: null,
        files: null,
        pinnedRef: null,
        notice: null,
      }
    case 'needs-trust':
      return {
        action: { kind: 'trust-install', label: 'Trust and install' },
        busy: false,
        trustPrompt: true,
        permissions: state.permissions,
        files: state.files ?? null,
        pinnedRef: state.pinnedRef ?? null,
        notice: null,
      }
    case 'installing':
      return {
        action: null,
        busy: true,
        busyLabel: 'Installing…',
        trustPrompt: false,
        permissions: null,
        files: null,
        pinnedRef: null,
        notice: null,
      }
    case 'installed': {
      // A module's code loads at app launch, so an install that landed one is
      // on disk and not yet in the app. The sentence says the whole state —
      // what happened, and what is left to do — rather than "Installed." and a
      // door the person then cannot find.
      const done = state.updated ? 'Updated to the latest version.' : 'Installed.'
      const message = state.restartRequired ? `${done} Restart SprintEngine Studio to use it.` : done
      return {
        action: null,
        busy: false,
        trustPrompt: false,
        permissions: null,
        files: null,
        pinnedRef: null,
        // A skill that shipped without bundled content installs nothing; the
        // notice tone warns so the user sees which listed skills they did not
        // get, rather than the flat "Installed." hiding the gap.
        notice: state.notices?.length ? { tone: 'warn', message, issues: state.notices } : { tone: 'good', message },
      }
    }
    case 'blocked':
      // No install affordance (action: null). Invalid is an error tone; unsigned
      // is a warn tone — both still block, and the message carries the reason.
      return {
        action: null,
        busy: false,
        trustPrompt: false,
        permissions: null,
        files: null,
        pinnedRef: null,
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
        files: null,
        pinnedRef: null,
        notice: { tone: 'error', message: state.message, issues: state.issues },
      }
  }
}
