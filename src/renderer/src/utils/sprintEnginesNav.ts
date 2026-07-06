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
  folderPath?: string | null
  createdAt?: number
  lastTerminalActivityAt?: number | null
  archivedAt?: number | null
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
  // Last segment of the workspace's project folder — the aside's project
  // filter and row subtitle read this; null for folderless workspaces.
  projectName: string | null
  createdAt: number
  // Same "last worked" rollup the sidebar recency sort uses: activity if any,
  // else creation.
  lastWorkedAt: number
  archived: boolean
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
  // A merged run is a terminal-complete state, ranked with `done` so it keeps
  // its prior nav position (it used to derive `done` before the merged glyph).
  done_merged: 4,
}

function rowRank(glyph: WorkspaceRunGlyph | null): number {
  if (!glyph) return 5
  return GLYPH_RANK[glyph.state] ?? 5
}

// Pure row derivation for the Sprint Engines aside. `deriveGlyph` is a
// port so the caller wires in the live rollup (workspaceRunGlyph + terminal
// activity) while tests pass a stub; the function itself owns membership,
// task-progress counting, and the attention-first ordering.
function projectDisplayName(folderPath: string | null | undefined): string | null {
  if (!folderPath) return null
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/u, '')
  const lastSlash = normalized.lastIndexOf('/')
  return (lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)) || normalized
}

export function buildSprintEngineNavRows<W extends SprintEngineNavWorkspaceInput>(
  workspaces: readonly W[],
  deriveGlyph: (workspace: W) => WorkspaceRunGlyph | null,
): SprintEngineNavRow[] {
  return workspaces
    .filter((workspace) => isSprintEngineWorkspace(workspace))
    .map((workspace) => {
      const tasks = workspace.sprintEngineState?.tasks ?? []
      const createdAt = workspace.createdAt ?? 0
      return {
        workspaceId: workspace.id,
        name: workspace.name,
        goal: workspace.sprintEngineState?.goal ?? '',
        glyph: deriveGlyph(workspace),
        doneTasks: tasks.filter((task) => task.status === 'done').length,
        totalTasks: tasks.length,
        projectName: projectDisplayName(workspace.folderPath),
        createdAt,
        lastWorkedAt: Math.max(createdAt, workspace.lastTerminalActivityAt ?? 0),
        archived: typeof workspace.archivedAt === 'number',
      }
    })
    .sort((a, b) => {
      const rank = rowRank(a.glyph) - rowRank(b.glyph)
      if (rank !== 0) return rank
      return a.name.localeCompare(b.name)
    })
}

// ---------------------------------------------------------------------------
// Aside view lenses / sort — pure, mirroring the Backlog panel's
// matchesBacklogView / compareBacklogItems idiom so the two survey surfaces
// filter the same way.

export type SprintsView = 'active' | 'attention' | 'running' | 'completed' | 'archived'
export type SprintsSort = 'attention' | 'updated_desc' | 'updated_asc' | 'created_desc' | 'created_asc'

// Glyph states that mean "waiting on the user": input requests, failures,
// review rework, held runs, and finished-but-unmerged branches.
const ATTENTION_STATES = new Set<WorkspaceRunGlyph['state']>([
  'needs_input',
  'failed',
  'changes_requested',
  'paused',
  'done_unmerged',
])

const COMPLETED_STATES = new Set<WorkspaceRunGlyph['state']>(['done', 'done_merged', 'done_unmerged'])

// `archived` is its own terminal lens (matching the Backlog panel); every
// other lens hides archived rows. `active` is the default firehose of
// everything not archived.
export function matchesSprintsView(row: SprintEngineNavRow, view: SprintsView): boolean {
  if (view === 'archived') return row.archived
  if (row.archived) return false
  switch (view) {
    case 'active':
      return true
    case 'attention':
      return row.glyph != null && ATTENTION_STATES.has(row.glyph.state)
    case 'running':
      return row.glyph?.state === 'in_progress'
    case 'completed':
      return row.glyph != null && COMPLETED_STATES.has(row.glyph.state)
    default:
      return true
  }
}

export function matchesSprintsQuery(row: SprintEngineNavRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    row.name.toLowerCase().includes(q)
    || row.goal.toLowerCase().includes(q)
    || (row.projectName ?? '').toLowerCase().includes(q)
  )
}

export function compareSprintsRows(a: SprintEngineNavRow, b: SprintEngineNavRow, sort: SprintsSort): number {
  switch (sort) {
    case 'updated_desc':
      return b.lastWorkedAt - a.lastWorkedAt || a.name.localeCompare(b.name)
    case 'updated_asc':
      return a.lastWorkedAt - b.lastWorkedAt || a.name.localeCompare(b.name)
    case 'created_desc':
      return b.createdAt - a.createdAt || a.name.localeCompare(b.name)
    case 'created_asc':
      return a.createdAt - b.createdAt || a.name.localeCompare(b.name)
    case 'attention':
    default: {
      const rank = rowRank(a.glyph) - rowRank(b.glyph)
      if (rank !== 0) return rank
      return a.name.localeCompare(b.name)
    }
  }
}
