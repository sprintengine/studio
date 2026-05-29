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
  'dev-tools',
  'git',
  'memory-graph',
  'switchboard',
  'multiloop',
  'sprint-engine',
  'mobile-relay',
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
// root). The v1 loader imports these in-process for trusted modules (like a
// bundled module's registerMain); wiring is a later Phase 7 increment.
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
  /** Code entry points (third-party); in-process loading is a later increment. */
  entry?: ModuleEntry
  /** Detached signature over the manifest, if the module is signed. */
  signature?: ModuleSignature
}

// Trust classification of a third-party module (see module-signature.ts):
// 'trusted' (loadable), 'signed' (valid sig, awaiting user approval), 'unsigned'
// (awaiting approval), 'invalid' (tampered signature; blocked).
export type ModuleTrustStatus = 'trusted' | 'signed' | 'unsigned' | 'invalid'

// What the renderer shows for one installed third-party module.
export type ThirdPartyModuleView = {
  manifest: CapabilityManifest
  trust: ModuleTrustStatus
  fingerprint?: string
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
