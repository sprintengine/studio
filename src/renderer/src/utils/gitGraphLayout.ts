// Pure lane-layout for a commit DAG, consumed by the Git panel's branch graph.
//
// Input commits MUST arrive newest-first in an order where no parent precedes
// its children (git's `--date-order` / `--topo-order` both guarantee this).
// The algorithm walks top to bottom maintaining a set of "active lanes", each
// holding the hash of the next commit that lane is waiting to reach. A commit
// collapses every lane waiting for it into a single node, then hands its lanes
// to its parents: the first parent inherits the node's lane, additional parents
// (merges) reuse an existing lane already waiting for them or open a new one.
//
// Lane *colour* is deliberately not assigned here. Branch identity is carried by
// column position and ref labels, not hue (see the aesthetic north star). The
// renderer draws every lane in neutral ink and lights a single lane on demand.

export interface GitGraphInputCommit {
  hash: string
  parents: string[]
}

export type GitGraphLineKind =
  // Spans the full row height (a lane passing through, top column -> bottom column).
  | 'through'
  // Enters the node from the top edge (a child connecting down into this commit).
  | 'in'
  // Leaves the node toward the bottom edge (this commit connecting to a parent).
  | 'out'

export interface GitGraphLine {
  fromColumn: number
  toColumn: number
  kind: GitGraphLineKind
  /** Hash of the commit this lane is heading toward; used to trace ancestry. */
  hash: string
}

export interface GitGraphRow {
  hash: string
  /** Column the commit node sits in. */
  column: number
  /** Connectors to draw inside this row's gutter cell. */
  lines: GitGraphLine[]
}

export interface GitGraphLayout {
  rows: GitGraphRow[]
  /** Number of lane columns the widest row uses; drives gutter width. */
  columns: number
}

function firstFreeColumn(lanes: (string | null)[]): number {
  const index = lanes.indexOf(null)
  return index === -1 ? lanes.length : index
}

function lastOccupiedColumn(lanes: (string | null)[]): number {
  for (let index = lanes.length - 1; index >= 0; index -= 1) {
    if (lanes[index] !== null) return index
  }
  return -1
}

export function computeGitGraphLayout(commits: GitGraphInputCommit[]): GitGraphLayout {
  // Each slot holds the hash the lane is waiting to reach, or null when free.
  const activeLanes: (string | null)[] = []
  const rows: GitGraphRow[] = []
  let columns = 0

  for (const commit of commits) {
    const lanesBefore = [...activeLanes]

    // Lanes waiting for this commit converge into its node.
    const incoming: number[] = []
    activeLanes.forEach((waitingFor, index) => {
      if (waitingFor === commit.hash) incoming.push(index)
    })

    const column = incoming.length > 0 ? Math.min(...incoming) : firstFreeColumn(activeLanes)

    // Free every lane that converged (including the node's own column); parents
    // re-occupy lanes below.
    incoming.forEach((index) => {
      activeLanes[index] = null
    })
    while (activeLanes.length <= column) activeLanes.push(null)

    // Hand lanes to parents. A parent already awaited by a lane is reused (the
    // node merges into it, no duplicate lane); otherwise the first parent
    // inherits the node's column to keep history vertical, and merge parents
    // open a new lane to the right.
    commit.parents.forEach((parent, parentIndex) => {
      if (activeLanes.includes(parent)) return
      if (parentIndex === 0) {
        activeLanes[column] = parent
        return
      }
      const free = firstFreeColumn(activeLanes)
      while (activeLanes.length <= free) activeLanes.push(null)
      activeLanes[free] = parent
    })

    const lines: GitGraphLine[] = []
    lanesBefore.forEach((waitingFor, index) => {
      if (waitingFor === null) return
      if (waitingFor === commit.hash) {
        lines.push({ fromColumn: index, toColumn: column, kind: 'in', hash: commit.hash })
      } else {
        // Passing lanes keep their column; non-null lanes are never relocated.
        lines.push({ fromColumn: index, toColumn: index, kind: 'through', hash: waitingFor })
      }
    })
    commit.parents.forEach((parent) => {
      const parentColumn = activeLanes.indexOf(parent)
      if (parentColumn !== -1) {
        lines.push({ fromColumn: column, toColumn: parentColumn, kind: 'out', hash: parent })
      }
    })

    rows.push({ hash: commit.hash, column, lines })

    const rowWidth = Math.max(
      column + 1,
      lastOccupiedColumn(lanesBefore) + 1,
      lastOccupiedColumn(activeLanes) + 1
    )
    columns = Math.max(columns, rowWidth)
  }

  return { rows, columns }
}
