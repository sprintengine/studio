// Capability module system — shared contracts.
//
// A "capability module" is a self-describing unit that owns one feature end to
// end (git, the editor, Sprint Engine, the memory graph, …) and contributes to
// the extension surfaces it needs. This file holds the process-agnostic types so
// the main, preload, and renderer hosts all speak the same vocabulary.
//
// See future-plans/2026-05-28-feature-level-pluggable-architecture.md for the
// design rationale. Phase 0 ships the contracts, the main-process kernel, and a
// pure enablement resolver; later phases migrate features onto it and add the
// renderer/preload hosts plus the user-facing module chooser.

// Ids of the bundled (first-party) modules — the reserved set a third-party
// module may not claim (it must not shadow/impersonate a built-in feature).
// This is the explicit cross-process source of truth: neither process can
// derive it alone (main sees only main modules; the renderer can't be imported
// here). MUST be updated when a bundled module is added/renamed — the drift
// guard in src/renderer/src/modules/bundled-ids.test.ts fails if it diverges
// from the actual bundled renderer module manifests.
export const BUNDLED_MODULE_IDS: readonly string[] = [
  'agent-runtime',
  'backlog',
  'dev-tools',
  'git',
  'memory-graph',
  'switchboard',
  'multiloop',
  'sprint-engine',
  'automations',
  'roadmap',
  'mobile-relay',
  'voice-dictation',
]

export type CapabilityCategory =
  | 'core'
  | 'dev-tools'
  | 'vcs'
  | 'orchestration'
  | 'insight'
  | 'connectivity'
  | (string & {})

// Where a module came from. Absent means 'bundled' (first-party, compiled in).
// 'third-party' modules are discovered from ~/.multicode/modules/, carry declared
// permissions + an optional signature, and are gated by trust (Phase 7).
export type ModuleSource = 'bundled' | 'third-party'

// A detached signature over the canonical manifest (signature field excluded).
// `publicKey` is the signer's ed25519 public key, base64 SPKI/DER; `signature`
// is base64. Verified by src/main/modules/module-signature.ts.
export type ModuleSignature = {
  algorithm: 'ed25519'
  publicKey: string
  signature: string
}

// Code entry points for a third-party module's bundles (relative to the module
// root). The main loader imports `entry.main` in-process only for trusted
// modules, using the same MainHost registration contract as bundled modules;
// `entry.renderer` is served to the renderer loader under the same trust gate.
// `entry.preload` is reserved and intentionally NOT loaded in v1: preload
// scripts must be registered at window creation, which forces app-restart
// semantics and widens the attack surface. Deferred until a concrete need.
export type ModuleEntry = {
  main?: string
  preload?: string
  renderer?: string
}

export type CapabilityManifest = {
  id: string
  displayName: string
  version: number
  publisher?: string
  category?: CapabilityCategory
  summary?: string
  /** Whether the module loads when the user has expressed no preference. */
  defaultEnabled: boolean
  /**
   * Core modules are always enabled and cannot be turned off in the chooser.
   * `agent-runtime` is the canonical example: everything else sits on top of it.
   */
  core?: boolean
  /** Capability ids this module needs loaded (and enabled) before it can load. */
  dependsOn?: string[]
  /** Capability ids that must not be enabled at the same time as this one. */
  conflictsWith?: string[]
  /** Provenance. Absent ⇒ bundled first-party. */
  source?: ModuleSource
  /** Capability scopes a third-party module requests (shown at install/trust). */
  permissions?: string[]
  /** Code entry points (third-party); trusted `entry.main` loads in the main process. */
  entry?: ModuleEntry
  /** Detached signature over the manifest, if the module is signed. */
  signature?: ModuleSignature
}

// Trust classification of a third-party module (see module-signature.ts):
// 'trusted' (loadable), 'signed' (valid sig, awaiting user approval), 'unsigned'
// (awaiting approval), 'invalid' (tampered signature; blocked).
export type ModuleTrustStatus = 'trusted' | 'signed' | 'unsigned' | 'invalid'

export type ThirdPartyModuleLaunchStatus =
  | 'trusted_executable'
  | 'trusted_manifest_only'
  | 'blocked_unsigned'
  | 'blocked_signed'
  | 'blocked_invalid'
  | 'launch_error'

// Whether a module's `entry.renderer` can be served to the renderer loader:
// 'none' — the manifest declares no renderer entry; 'blocked' — declared, but
// the module's trust status is not load-eligible; 'error' — declared and
// trusted, but the entry is rejected (escapes the module root or the bundle
// file is missing); 'available' — declared, trusted, contained, servable.
export type ThirdPartyRendererEntryAvailability = 'none' | 'blocked' | 'error' | 'available'

export type ThirdPartyRendererEntryView = {
  availability: ThirdPartyRendererEntryAvailability
  /** Sanitized human-readable detail; never contains absolute paths. */
  message?: string
}

export type ThirdPartyModuleLaunchView = {
  status: ThirdPartyModuleLaunchStatus
  hasMainEntry: boolean
  expectedToLoad: boolean
  message?: string
  /**
   * Renderer-entry availability for this module. Always populated by the
   * main-process list IPC; optional so older fixtures stay valid.
   */
  rendererEntry?: ThirdPartyRendererEntryView
}

// IPC channel that serves loadable third-party renderer entries. Owned by the
// module-host kernel ('@host'); the renderer loader invokes it at boot.
export const THIRD_PARTY_RENDERER_ENTRIES_CHANNEL = 'modules:third-party:renderer-entries'

// One servable renderer entry: the module is trusted (isLoadEligible), its
// `entry.renderer` resolves inside the module root, and the bundle was read
// from disk. `code` is the ESM bundle source; the renderer loader evaluates it
// via dynamic import of a blob URL — content over IPC keeps delivery free of
// any file:// / custom-protocol surface.
export type ThirdPartyRendererEntry = {
  id: string
  manifest: CapabilityManifest
  code: string
}

export type ThirdPartyRendererEntriesResult = {
  entries: ThirdPartyRendererEntry[]
  /**
   * Modules whose declared renderer entry could not be served, keyed by module
   * id to a sanitized reason (no absolute paths). Trust-blocked modules are
   * NOT listed here — they are reported through their existing launch statuses.
   */
  failures: Record<string, string>
}

// What the renderer shows for one installed third-party module.
export type ThirdPartyModuleView = {
  manifest: CapabilityManifest
  trust: ModuleTrustStatus
  fingerprint?: string
  launch: ThirdPartyModuleLaunchView
}

export type ModuleManifestIssue = { path: string; message: string }

export type ThirdPartyModuleListResult = {
  modules: ThirdPartyModuleView[]
  rejected: Array<{ path: string; issues: ModuleManifestIssue[] }>
}

export type ThirdPartyModuleInstallResult = {
  ok: boolean
  id?: string
  trust?: ModuleTrustStatus
  message?: string
  issues?: ModuleManifestIssue[]
}

export type ThirdPartyModuleTrustResult = { ok: boolean; message?: string }

/**
 * User/workspace enablement overrides, keyed by module id. A `true`/`false`
 * value overrides the manifest's `defaultEnabled`. Core modules ignore
 * overrides. Unknown ids are ignored.
 */
export type ModuleEnablementOverrides = Record<string, boolean>

// Shared by the renderer settings store and the main-process enablement cache
// so both processes normalize persisted/IPC overrides identically: drop empty
// keys and non-boolean values.
export function normalizeModuleOverrides(value: unknown): ModuleEnablementOverrides {
  if (!value || typeof value !== 'object') return {}
  const out: ModuleEnablementOverrides = {}
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 0 && typeof enabled === 'boolean') out[key] = enabled
  }
  return out
}

export type ModuleResolutionErrorCode =
  | 'duplicate_id'
  | 'missing_dependency'
  | 'disabled_dependency'
  | 'conflict'
  | 'dependency_cycle'
  // A third-party module the user enabled but hasn't trusted yet.
  | 'untrusted'
  // A third-party module whose signature failed verification (tampered).
  | 'invalid_signature'

export type ModuleResolutionError = {
  /** The module the error is attributed to (empty for whole-graph errors). */
  id: string
  code: ModuleResolutionErrorCode
  message: string
}

export type ModuleResolution = {
  /** Module ids that should load, ordered so dependencies precede dependents. */
  order: string[]
  /** Module ids intentionally left off (user preference or `defaultEnabled: false`). */
  disabled: string[]
  /** Modules that wanted to load but cannot (broken dependency, conflict, cycle). */
  errors: ModuleResolutionError[]
}
