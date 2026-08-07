// The module registry as the user sees it, mirrored renderer → main.
//
// The renderer owns the module universe: it registers every bundled renderer
// module (already narrowed to the build channel by `activeForChannel`), loads
// the trusted third-party ones, and holds the enablement overrides that decide
// what actually resolves. Main sees only its own half — the main-process
// modules plus the installed third-party folders — so anything that has to
// answer "what modules does this app have, and is one of them on?" must read
// the renderer's answer, not re-derive a second one.
//
// This is the same mirror shape as module enablement (`modules:set-enablement`)
// and the terminal idle policy: the renderer pushes on boot and on every change,
// main caches the last push in memory, and a consumer that has not received one
// yet says so rather than inventing an empty registry. Nothing here is
// persisted — it is a projection of live renderer state, valid only for the
// running app session.
//
// Consumer today: the `module.*` gateway tools (src/main/automation).

import type { CapabilityManifest, ModuleResolutionErrorCode, ModuleSource } from './manifest'

/** Renderer → main push of the current module registry. */
export const MODULE_REGISTRY_SNAPSHOT_CHANNEL = 'modules:set-registry-snapshot'

/**
 * Which build the snapshot was taken in. `production` is a packaged build,
 * where the dev-only modules are absent from the registry entirely — never
 * present-but-disabled (see shared/modules/dev-only.ts).
 */
export type ModuleBuildChannel = 'development' | 'production'

/**
 * What a module contributes to the app, by surface kind — ids only, never
 * components. Panels are deliberately absent: the renderer kernel resolves a
 * panel by component id but does not enumerate them, so a panel list here would
 * be a guess.
 */
export type ModuleContributedSurfaces = {
  workspaceTypes: string[]
  globalSurfaces: string[]
  sidebarNavEntries: string[]
  settingsSections: string[]
  commands: string[]
  topBarItems: string[]
  backlogItemActions: string[]
  workspaceAsides: string[]
}

export const EMPTY_MODULE_SURFACES: ModuleContributedSurfaces = {
  workspaceTypes: [],
  globalSurfaces: [],
  sidebarNavEntries: [],
  settingsSections: [],
  commands: [],
  topBarItems: [],
  backlogItemActions: [],
  workspaceAsides: [],
}

/**
 * Why a module in the registry is not active. `disabled` is the user's own
 * switch (or a `defaultEnabled: false` nobody turned on); every other reason is
 * a resolution failure carrying the resolver's own code — a dependency that is
 * missing or off, a conflict, a cycle, or third-party trust.
 */
export type ModuleAbsence = {
  reason: 'disabled' | ModuleResolutionErrorCode
  message: string
}

export type ModuleRegistryEntry = {
  id: string
  /** The manifest as registered — the module's own self-description. */
  manifest: CapabilityManifest
  /** Provenance. Bundled modules are compiled in; third-party come from ~/.multicode/modules. */
  source: ModuleSource
  /** Resolved through the same enablement resolution the app gates its surfaces on. */
  enabled: boolean
  /** Null when the module is enabled. */
  absence: ModuleAbsence | null
  surfaces: ModuleContributedSurfaces
}

export type ModuleRegistrySnapshot = {
  /** Epoch ms the renderer captured this at; a consumer can disclose its age. */
  capturedAt: number
  channel: ModuleBuildChannel
  /**
   * Every module in the registry universe for this build channel. Dev-only
   * modules excluded from a packaged build are ABSENT here, not disabled.
   */
  modules: ModuleRegistryEntry[]
}

// The upper bound `new Date(ms).toISOString()` accepts (ECMAScript time range).
const MAX_TIMESTAMP_MS = 8.64e15

/** Answer to a push: `ok: false` names why the snapshot was refused. */
export type ModuleRegistrySnapshotWriteResult = { ok: boolean; message?: string }

/**
 * Validate a pushed snapshot at the main-process boundary. The sender is our own
 * renderer, but an IPC payload is still input: a malformed push must be refused
 * outright rather than cached as a half-registry that consumers would read as
 * fact. Returns null when the value is not a usable snapshot.
 */
export function normalizeModuleRegistrySnapshot(value: unknown): ModuleRegistrySnapshot | null {
  if (!isRecord(value)) return null
  const { capturedAt, channel, modules } = value
  // Bounded, not merely finite: a consumer formats this as a date, and
  // `new Date(1e21).toISOString()` throws rather than returning nonsense.
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null
  if (capturedAt <= 0 || capturedAt > MAX_TIMESTAMP_MS) return null
  if (channel !== 'development' && channel !== 'production') return null
  if (!Array.isArray(modules)) return null
  const normalized: ModuleRegistryEntry[] = []
  for (const entry of modules) {
    const module = normalizeEntry(entry)
    if (!module) return null
    normalized.push(module)
  }
  return { capturedAt, channel, modules: normalized }
}

function normalizeEntry(value: unknown): ModuleRegistryEntry | null {
  if (!isRecord(value)) return null
  const { id, manifest, source, enabled, absence, surfaces } = value
  if (typeof id !== 'string' || id.trim().length === 0) return null
  if (!isRecord(manifest) || typeof manifest.id !== 'string') return null
  if (source !== 'bundled' && source !== 'third-party') return null
  if (typeof enabled !== 'boolean') return null
  return {
    id,
    manifest: manifest as unknown as CapabilityManifest,
    source,
    enabled,
    absence: normalizeAbsence(absence),
    surfaces: normalizeSurfaces(surfaces),
  }
}

function normalizeAbsence(value: unknown): ModuleAbsence | null {
  if (!isRecord(value)) return null
  const { reason, message } = value
  if (typeof reason !== 'string' || reason.length === 0) return null
  return { reason: reason as ModuleAbsence['reason'], message: typeof message === 'string' ? message : '' }
}

function normalizeSurfaces(value: unknown): ModuleContributedSurfaces {
  if (!isRecord(value)) return { ...EMPTY_MODULE_SURFACES }
  const read = (key: keyof ModuleContributedSurfaces): string[] => {
    const list = value[key]
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
  }
  return {
    workspaceTypes: read('workspaceTypes'),
    globalSurfaces: read('globalSurfaces'),
    sidebarNavEntries: read('sidebarNavEntries'),
    settingsSections: read('settingsSections'),
    commands: read('commands'),
    topBarItems: read('topBarItems'),
    backlogItemActions: read('backlogItemActions'),
    workspaceAsides: read('workspaceAsides'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
