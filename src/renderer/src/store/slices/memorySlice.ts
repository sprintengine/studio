import { DEFAULT_GRAPH_SETTINGS, normalizeGraphSettings } from '../../components/memory/memoryGraphTypes'
import { normalizeProjectRootKey } from '../../utils/projectKnowledge'
import type {
  AppSettings,
  MemoryGraphSettings,
  Workspace,
  WorkspaceId,
  WorkspaceMemoryConfig,
} from '../../types/workspace'

export const defaultWorkspaceMemoryConfig = (): WorkspaceMemoryConfig => ({
  relativeRoot: null,
  graphSettings: { ...DEFAULT_GRAPH_SETTINGS },
})

export function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

export function normalizeMemoryRelativeRoot(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
  if (!normalized || normalized === '.' || isAbsolutePath(normalized)) return null
  return normalized
}

export function normalizeWorkspaceMemoryConfig(
  input: Partial<WorkspaceMemoryConfig> | null | undefined,
): WorkspaceMemoryConfig {
  return {
    relativeRoot: normalizeMemoryRelativeRoot(input?.relativeRoot),
    graphSettings: normalizeGraphSettings(input?.graphSettings),
  }
}

export function normalizeProjectKnowledgeRoots(roots: unknown, workspaces: Workspace[]): Record<string, string | null> {
  const normalized: Record<string, string | null> = {}

  if (roots && typeof roots === 'object') {
    for (const [projectRoot, relativeRoot] of Object.entries(roots as Record<string, unknown>)) {
      const key = normalizeProjectRootKey(projectRoot)
      const root = normalizeMemoryRelativeRoot(relativeRoot)
      if (key && root) normalized[key] = root
    }
  }

  for (const workspace of workspaces) {
    const projectRoot = normalizeProjectRootKey(workspace.folderPath)
    const relativeRoot = normalizeMemoryRelativeRoot(workspace.memory?.relativeRoot)
    if (projectRoot && relativeRoot && !normalized[projectRoot]) normalized[projectRoot] = relativeRoot
  }

  return normalized
}

interface MemorySliceState {}

interface MemorySliceActions {
  setWorkspaceMemoryRelativeRoot: (workspaceId: WorkspaceId, relativeRoot: string | null) => void
  updateMemoryGraphSettings: (
    workspaceId: WorkspaceId,
    update:
      | Partial<MemoryGraphSettings>
      | ((current: MemoryGraphSettings) => Partial<MemoryGraphSettings> | MemoryGraphSettings),
  ) => void
  setProjectKnowledgeRoot: (projectRoot: string, relativeRoot: string | null) => void
}

export type MemorySlice = MemorySliceState & MemorySliceActions

type MemorySliceCarrier = { workspaces: Workspace[]; appSettings: AppSettings }
type MemorySliceSet = (mutator: (state: MemorySliceCarrier) => void) => void

export function createMemorySlice(set: MemorySliceSet): MemorySlice {
  return {
    setWorkspaceMemoryRelativeRoot: (workspaceId, relativeRoot) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        ws.memory = {
          relativeRoot: normalizeMemoryRelativeRoot(relativeRoot),
          graphSettings: normalizeGraphSettings(ws.memory?.graphSettings),
        }
      }),

    updateMemoryGraphSettings: (workspaceId, update) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeGraphSettings(ws.memory?.graphSettings)
        const patch = typeof update === 'function' ? update(current) : update
        const next = normalizeGraphSettings({ ...current, ...patch })
        ws.memory = {
          relativeRoot: normalizeMemoryRelativeRoot(ws.memory?.relativeRoot),
          graphSettings: next,
        }
      }),

    setProjectKnowledgeRoot: (projectRoot, relativeRoot) =>
      set((state) => {
        const key = normalizeProjectRootKey(projectRoot)
        if (!key) return
        const normalizedRoot = normalizeMemoryRelativeRoot(relativeRoot)
        state.appSettings.projectKnowledgeRoots = normalizeProjectKnowledgeRoots(
          state.appSettings.projectKnowledgeRoots,
          state.workspaces,
        )
        if (normalizedRoot) {
          state.appSettings.projectKnowledgeRoots[key] = normalizedRoot
        } else {
          delete state.appSettings.projectKnowledgeRoots[key]
        }
        for (const workspace of state.workspaces) {
          if (normalizeProjectRootKey(workspace.folderPath) !== key) continue
          workspace.memory = {
            relativeRoot: null,
            graphSettings: normalizeGraphSettings(workspace.memory?.graphSettings),
          }
        }
      }),
  }
}
