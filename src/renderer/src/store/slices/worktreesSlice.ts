import type {
  Workspace,
  WorkspaceId,
  WorkspaceWorktreeState,
  WorktreeEntry,
} from '../../types/workspace'

export const defaultWorkspaceWorktreeState = (): WorkspaceWorktreeState => ({
  containerPath: null,
  entries: {},
  updatedAt: null,
})

export function normalizeWorktreeEntry(input: Partial<WorktreeEntry> | null | undefined): WorktreeEntry | null {
  if (!input || typeof input.id !== 'string' || !input.id.trim()) return null
  if (typeof input.path !== 'string' || !input.path.trim()) return null

  const status = (
    input.status === 'assigned'
    || input.status === 'missing'
    || input.status === 'removing'
    || input.status === 'error'
  )
    ? input.status
    : 'available'
  const now = Date.now()

  return {
    id: input.id.trim(),
    path: input.path,
    branch: typeof input.branch === 'string' && input.branch.trim() ? input.branch : null,
    ownerAgentId:
      typeof input.ownerAgentId === 'string' && input.ownerAgentId.trim()
        ? input.ownerAgentId
        : null,
    status,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
    missingAt:
      status === 'missing'
        ? typeof input.missingAt === 'number'
          ? input.missingAt
          : now
        : null,
  }
}

export function normalizeWorkspaceWorktreeState(
  input: Partial<WorkspaceWorktreeState> | null | undefined
): WorkspaceWorktreeState {
  const entries = Object.fromEntries(
    Object.values(input?.entries ?? {})
      .map((entry) => normalizeWorktreeEntry(entry))
      .filter((entry): entry is WorktreeEntry => Boolean(entry))
      .map((entry) => [entry.id, entry])
  )

  return {
    containerPath:
      typeof input?.containerPath === 'string' && input.containerPath.trim()
        ? input.containerPath
        : null,
    entries,
    updatedAt: typeof input?.updatedAt === 'number' ? input.updatedAt : null,
  }
}

interface WorktreesSliceState {}

interface WorktreesSliceActions {
  setWorkspaceWorktreeState: (
    workspaceId: WorkspaceId,
    worktreeState: Partial<WorkspaceWorktreeState> | null
  ) => void
  upsertWorktreeEntry: (workspaceId: WorkspaceId, entry: WorktreeEntry) => void
  markWorktreeMissing: (workspaceId: WorkspaceId, worktreeId: string, missingAt?: number) => void
  removeWorktreeEntry: (workspaceId: WorkspaceId, worktreeId: string) => void
}

export type WorktreesSlice = WorktreesSliceState & WorktreesSliceActions

type WorktreesSliceCarrier = { workspaces: Workspace[] }
type WorktreesSliceSet = (mutator: (state: WorktreesSliceCarrier) => void) => void

export function createWorktreesSlice(set: WorktreesSliceSet): WorktreesSlice {
  return {
    setWorkspaceWorktreeState: (workspaceId, worktreeState) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeWorkspaceWorktreeState(ws.worktreeState)
        ws.worktreeState = normalizeWorkspaceWorktreeState(
          worktreeState
            ? {
              ...current,
              ...worktreeState,
              entries: worktreeState.entries ?? current.entries,
            }
            : null
        )
      }),

    upsertWorktreeEntry: (workspaceId, entry) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        ws.worktreeState = normalizeWorkspaceWorktreeState(ws.worktreeState)
        const normalized = normalizeWorktreeEntry(entry)
        if (!normalized) return
        ws.worktreeState.entries[normalized.id] = normalized
        ws.worktreeState.updatedAt = normalized.updatedAt
      }),

    markWorktreeMissing: (workspaceId, worktreeId, missingAt = Date.now()) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        const entry = ws?.worktreeState?.entries[worktreeId]
        if (!ws || !entry) return
        entry.status = 'missing'
        entry.missingAt = missingAt
        entry.updatedAt = missingAt
        ws.worktreeState.updatedAt = missingAt
      }),

    removeWorktreeEntry: (workspaceId, worktreeId) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws?.worktreeState?.entries[worktreeId]) return
        delete ws.worktreeState.entries[worktreeId]
        ws.worktreeState.updatedAt = Date.now()
      }),
  }
}
