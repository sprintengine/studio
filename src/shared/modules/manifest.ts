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

export type CapabilityCategory =
  | 'core'
  | 'dev-tools'
  | 'vcs'
  | 'orchestration'
  | 'insight'
  | 'connectivity'
  | (string & {})

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
}

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
