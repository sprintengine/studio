// Workspace registry repository
//
// Owns the persisted workspace-registry storage key. The custom storage adapter
// in workspaceStore.ts is the only consumer that calls into this module; every
// other surface (settings, learning, auth, sidebar, terminal reconciliation)
// reaches localStorage through a separate app-settings key and physically cannot
// modify the registry by construction.
//
// Persisted v46 envelope shape (stored at WORKSPACE_REGISTRY_STORAGE_KEY):
//   {
//     state: {
//       workspaces: Workspace[]
//       activeWorkspaceId: WorkspaceId | null
//       workspaceRegistryEmptyState: WorkspaceRegistryEmptyState | null
//     },
//     version: 46,
//   }
//
// Empty-state semantics (per the task acceptance):
//   - workspaces.length > 0      → classification: present (recoverable target)
//   - workspaces.length === 0
//     && workspaceRegistryEmptyState != null      → intentional user removal (no recovery)
//   - workspaces.length === 0
//     && workspaceRegistryEmptyState == null      → dangerous empty (recovery target if backup
//                                   exists and is non-empty)
//   - localStorage missing       → dangerous_empty_missing_storage
//   - localStorage unreadable    → dangerous_empty_unreadable
//   - schema corruption          → dangerous_empty_no_workspaces

import type { Workspace, WorkspaceId, WorkspaceRegistryEmptyState } from '../../types/workspace'

export const WORKSPACE_REGISTRY_STORAGE_KEY = 'multicode-workspaces'
export const WORKSPACE_REGISTRY_VERSION = 46

export type WorkspaceRegistryState = {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceRegistryEmptyState: WorkspaceRegistryEmptyState | null
}

export type WorkspaceRegistryEnvelope = {
  state: WorkspaceRegistryState
  version: number
}

export type WorkspaceRegistryClassification =
  | 'present'
  | 'intentional_empty'
  | 'dangerous_empty_missing_storage'
  | 'dangerous_empty_unreadable'
  | 'dangerous_empty_no_workspaces'

type ClassifyInput = { rawLocalStorage: string | null }

export function classifyWorkspaceRegistry(input: ClassifyInput): WorkspaceRegistryClassification {
  if (input.rawLocalStorage === null) return 'dangerous_empty_missing_storage'

  let parsed: { state?: Partial<WorkspaceRegistryState> } | null = null
  try {
    parsed = JSON.parse(input.rawLocalStorage) as { state?: Partial<WorkspaceRegistryState> }
  } catch {
    return 'dangerous_empty_unreadable'
  }

  const state = parsed?.state
  if (!state || typeof state !== 'object') return 'dangerous_empty_unreadable'

  if (Array.isArray(state.workspaces) && state.workspaces.length > 0) return 'present'
  if (!Array.isArray(state.workspaces)) return 'dangerous_empty_no_workspaces'

  // workspaces is an empty array. Only an explicit workspaceRegistryEmptyState record proves
  // user intent. Shape inference (e.g., the presence of sibling fields) is
  // intentionally NOT used — startup writes carry those too.
  if (state.workspaceRegistryEmptyState && typeof state.workspaceRegistryEmptyState === 'object') {
    return 'intentional_empty'
  }
  return 'dangerous_empty_no_workspaces'
}

export function isDangerousRegistryClassification(
  classification: WorkspaceRegistryClassification,
): boolean {
  return classification !== 'present' && classification !== 'intentional_empty'
}

export function readRawWorkspaceRegistry(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(WORKSPACE_REGISTRY_STORAGE_KEY)
  } catch {
    return null
  }
}

export function readWorkspaceRegistryEnvelope(): WorkspaceRegistryEnvelope | null {
  const raw = readRawWorkspaceRegistry()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceRegistryEnvelope>
    if (!parsed || typeof parsed !== 'object') return null
    const state = parsed.state
    if (!state || typeof state !== 'object') return null
    if (!Array.isArray((state as WorkspaceRegistryState).workspaces)) return null
    return {
      state: state as WorkspaceRegistryState,
      version: typeof parsed.version === 'number' ? parsed.version : 0,
    }
  } catch {
    return null
  }
}

export function writeWorkspaceRegistry(envelope: WorkspaceRegistryEnvelope): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      WORKSPACE_REGISTRY_STORAGE_KEY,
      JSON.stringify(envelope),
    )
  } catch (error) {
    console.warn('[workspaceRegistry] localStorage write failed', {
      message: error instanceof Error ? error.message : 'unknown',
    })
  }
}

export function clearWorkspaceRegistryLocal(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(WORKSPACE_REGISTRY_STORAGE_KEY)
  } catch {
    // best-effort
  }
}

// Detect a legacy v44 envelope that still has appSettings/sidebarCollapsed
// sitting inside the workspaces key. T22 stored everything under one key;
// T23 splits non-workspace state into APP_SETTINGS_STORAGE_KEY. The split
// happens lazily inside the workspaceStore custom storage adapter on first
// cold-load after the upgrade.
type LegacyV44Shape = {
  state?: {
    workspaces?: unknown
    activeWorkspaceId?: unknown
    appSettings?: unknown
    sidebarCollapsed?: unknown
  }
  version?: number
}

export function isLegacyV44WorkspaceEnvelope(raw: string | null): boolean {
  if (!raw) return false
  try {
    const parsed = JSON.parse(raw) as LegacyV44Shape
    if (!parsed?.state) return false
    if ((parsed.version ?? 0) >= WORKSPACE_REGISTRY_VERSION) return false
    // Settings fields present inside the registry envelope = legacy.
    return parsed.state.appSettings !== undefined
      || parsed.state.sidebarCollapsed !== undefined
  } catch {
    return false
  }
}

// Splits a legacy v44 envelope into the new registry-only envelope plus the
// extracted non-workspace fields. Callers (the workspaceStore storage adapter)
// write the settings portion to APP_SETTINGS_STORAGE_KEY and the registry
// portion back into WORKSPACE_REGISTRY_STORAGE_KEY. workspaceRegistryEmptyState is backfilled
// to null on migrate; future user-removed-all operations will set it.
export type LegacyV44SplitResult = {
  registry: WorkspaceRegistryEnvelope
  extractedSettings: {
    appSettings: unknown
    sidebarCollapsed: unknown
  } | null
}

export function splitLegacyV44Envelope(raw: string): LegacyV44SplitResult | null {
  try {
    const parsed = JSON.parse(raw) as LegacyV44Shape
    const state = parsed?.state
    if (!state) return null

    const workspaces = Array.isArray(state.workspaces) ? (state.workspaces as Workspace[]) : []
    const activeWorkspaceId = (state.activeWorkspaceId as WorkspaceId | null | undefined) ?? null

    const hasSettingsFields = state.appSettings !== undefined || state.sidebarCollapsed !== undefined

    return {
      registry: {
        state: {
          workspaces,
          activeWorkspaceId,
          workspaceRegistryEmptyState: null,
        },
        // Preserve the legacy version so the persist middleware's migrate
        // ladder still runs against the workspace fields. The storage adapter
        // bumps version → WORKSPACE_REGISTRY_VERSION after writing back.
        version: typeof parsed.version === 'number' ? parsed.version : 0,
      },
      extractedSettings: hasSettingsFields
        ? {
            appSettings: state.appSettings,
            sidebarCollapsed: state.sidebarCollapsed,
          }
        : null,
    }
  } catch {
    return null
  }
}

// Convenience for the in-memory state default. The Zustand store seeds
// workspaceRegistryEmptyState to null at create time; this default mirrors that for tests.
export function defaultRegistryEmptyState(): WorkspaceRegistryEmptyState | null {
  return null
}
