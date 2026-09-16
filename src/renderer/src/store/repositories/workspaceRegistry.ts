// Workspace registry repository
//
// The persisted registry envelope and the lazy split of a legacy v44 envelope,
// which the workspaceStore custom storage adapter runs on first cold load. The
// storage key itself is `WORKSPACE_STORAGE_KEY` (slices/persistenceSlice.ts).
//
// Persisted v46 envelope shape:
//   {
//     state: {
//       workspaces: Workspace[]
//       activeWorkspaceId: WorkspaceId | null
//       workspaceRegistryEmptyState: WorkspaceRegistryEmptyState | null
//     },
//     version: 46,
//   }

import type { Workspace, WorkspaceId, WorkspaceRegistryEmptyState } from '../../types/workspace'

const WORKSPACE_REGISTRY_VERSION = 46

type WorkspaceRegistryState = {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceRegistryEmptyState: WorkspaceRegistryEmptyState | null
}

type WorkspaceRegistryEnvelope = {
  state: WorkspaceRegistryState
  version: number
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
