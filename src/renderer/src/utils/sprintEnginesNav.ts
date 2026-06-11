import type { WorkspaceRunGlyph } from './workspaceRunGlyph'

// One predicate for "this workspace is a Sprint Engine run surface", shared by
// the run-glyph provider registration and the Sprint Engines aside so the
// sidebar glyph and the aside list can never disagree about membership.
// Structural input (a subset of Workspace) keeps it usable from both the
// provider's narrowed projection and plain test fixtures.
export function isSprintEngineWorkspace(workspace: {
  mode: string
  sprintEngineContext?: unknown
}): boolean {
  return workspace.mode === 'sprintengine' || Boolean(workspace.sprintEngineContext)
}

// The Workspace fields the nav rows read — structural so the pure derivation
// stays testable without building full Workspace objects.
export type SprintEngineNavWorkspaceInput = {
  id: string
  name: string
  mode: string
  sprintEngineContext?: unknown
  sprintEngineState?: {
    goal?: string
    tasks?: readonly { status: string }[]
  } | null
}

export type SprintEngineNavRow = {
  workspaceId: string
  name: string
  goal: string
  glyph: WorkspaceRunGlyph | null
  doneTasks: number
  totalTasks: number
}

// Attention-first ordering for the nav list: what needs the user, then what is
// live, then held/unacknowledged runs, then everything resting. Within a rank
// rows sort by name so the list is stable while runs stream.
const GLYPH_RANK: Partial<Record<WorkspaceRunGlyph['state'], number>> = {
  needs_input: 0,
  failed: 1,
  in_progress: 2,
  paused: 3,
  done: 4,
}

function rowRank(glyph: WorkspaceRunGlyph | null): number {
  if (!glyph) return 5
  return GLYPH_RANK[glyph.state] ?? 5
}

// Pure row derivation for the Sprint Engines aside. `deriveGlyph` is a
// port so the caller wires in the live rollup (workspaceRunGlyph + terminal
// activity) while tests pass a stub; the function itself owns membership,
// task-progress counting, and the attention-first ordering.
export function buildSprintEngineNavRows<W extends SprintEngineNavWorkspaceInput>(
  workspaces: readonly W[],
  deriveGlyph: (workspace: W) => WorkspaceRunGlyph | null,
): SprintEngineNavRow[] {
  return workspaces
    .filter((workspace) => isSprintEngineWorkspace(workspace))
    .map((workspace) => {
      const tasks = workspace.sprintEngineState?.tasks ?? []
      return {
        workspaceId: workspace.id,
        name: workspace.name,
        goal: workspace.sprintEngineState?.goal ?? '',
        glyph: deriveGlyph(workspace),
        doneTasks: tasks.filter((task) => task.status === 'done').length,
        totalTasks: tasks.length,
      }
    })
    .sort((a, b) => {
      const rank = rowRank(a.glyph) - rowRank(b.glyph)
      if (rank !== 0) return rank
      return a.name.localeCompare(b.name)
    })
}
