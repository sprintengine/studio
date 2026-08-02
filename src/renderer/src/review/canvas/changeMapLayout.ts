// Pure, DOM-free layout for the Overview change map (MC-1685). Same philosophy
// as gitGraphLayout.ts: the guide names entities and relationships in the brief;
// the app owns a DETERMINISTIC layout so the same brief always renders the same
// pixels. No mermaid, no agent-drawn diagrams.
//
// Nodes are layered left-to-right by their step's reading order — every node in
// one step shares a column and stacks vertically in node order; a step with no
// nodes takes no column (columns are dense, but a node's badge is its step's
// true 1-based reading position, not the dense column index). Columns are
// vertically centered against the tallest one. Edges are cubic beziers: a
// horizontal S-curve between columns, a vertical one within a column.

import type { ChangeMap, ChangeMapNode, ChangeMapNodeKind } from '../../../../shared/review'

// Geometry — even integers so every derived coordinate lands on a whole pixel
// (column centering divides height gaps by two; horizontal/vertical control
// points halve the run), keeping layout output byte-stable across runs.
const PAD = 14
const NODE_W = 168
const NODE_H = 56
const COL_GAP = 74
const ROW_GAP = 22
const LABEL_LIFT = 7 // edge label sits just above a horizontal edge's midpoint
const LABEL_NUDGE = 8 // and just right of a vertical edge's midpoint

export interface ChangeMapLayoutNode {
  id: string
  label: string
  sublabel?: string
  kind: ChangeMapNodeKind
  stepId: string
  stepBadge: number // 1-based reading position of the node's step
  x: number
  y: number
  width: number
  height: number
}

export interface ChangeMapLayoutEdge {
  from: string
  to: string
  label?: string
  path: string // SVG path `d`, source -> target with an arrow at the target end
  labelX: number
  labelY: number
}

export interface ChangeMapLayout {
  width: number
  height: number
  nodes: ChangeMapLayoutNode[]
  edges: ChangeMapLayoutEdge[]
  ariaLabel: string // prose summary of the whole map for screen readers
}

interface Point {
  x: number
  y: number
}

// A prose summary a screen reader can read in place of the diagram: the entity
// count, then each relationship as "<from> <label> <to>", then the deploy note.
export function describeChangeMap(changeMap: ChangeMap): string {
  const byId = new Map(changeMap.nodes.map((node) => [node.id, node.label]))
  const count = changeMap.nodes.length
  const noun = count === 1 ? 'entity' : 'entities'
  let summary = `Change map of ${count} ${noun}`
  if (changeMap.edges.length > 0) {
    const relations = changeMap.edges.map((edge) => {
      const from = byId.get(edge.from) ?? edge.from
      const to = byId.get(edge.to) ?? edge.to
      return edge.label ? `${from} ${edge.label} ${to}` : `${from} to ${to}`
    })
    summary += `: ${relations.join('; ')}`
  } else if (count > 0) {
    summary += `: ${changeMap.nodes.map((node) => node.label).join(', ')}`
  }
  if (changeMap.deployNote) summary += `. Deploy order: ${changeMap.deployNote}`
  return `${summary}.`
}

// Deterministic layout for a change map. `orderedStepIds` is the brief's steps in
// reading order (from orderedSteps); it fixes the column order and each node's
// badge. Nodes whose stepId is absent from that list are placed after the known
// steps in first-seen order — defensive only; the validator guarantees every
// stepId references a step.
export function computeChangeMapLayout(changeMap: ChangeMap, orderedStepIds: string[]): ChangeMapLayout {
  const ariaLabel = describeChangeMap(changeMap)
  if (changeMap.nodes.length === 0) {
    return { width: 0, height: 0, nodes: [], edges: [], ariaLabel }
  }

  const badgeByStep = new Map<string, number>()
  orderedStepIds.forEach((stepId, index) => badgeByStep.set(stepId, index + 1))

  // Column index per step: known steps first in reading order, then any unknown
  // step in the order its first node appears.
  const columnByStep = new Map<string, number>()
  const stepsInColumnOrder: string[] = []
  const seenStep = (stepId: string): void => {
    if (columnByStep.has(stepId)) return
    columnByStep.set(stepId, -1)
    stepsInColumnOrder.push(stepId)
  }
  for (const stepId of orderedStepIds) {
    if (changeMap.nodes.some((node) => node.stepId === stepId)) seenStep(stepId)
  }
  for (const node of changeMap.nodes) seenStep(node.stepId)
  stepsInColumnOrder.forEach((stepId, index) => columnByStep.set(stepId, index))

  // Group node ids by column, preserving node-array order within a column.
  const rowsByColumn = new Map<number, ChangeMapNode[]>()
  for (const node of changeMap.nodes) {
    const column = columnByStep.get(node.stepId) ?? 0
    const bucket = rowsByColumn.get(column)
    if (bucket) bucket.push(node)
    else rowsByColumn.set(column, [node])
  }

  const columnHeight = (count: number): number => count * NODE_H + Math.max(0, count - 1) * ROW_GAP
  const maxRows = Math.max(...[...rowsByColumn.values()].map((rows) => rows.length))
  const contentHeight = columnHeight(maxRows)

  const placed = new Map<string, ChangeMapLayoutNode>()
  const nodes: ChangeMapLayoutNode[] = []
  for (const [column, rows] of [...rowsByColumn.entries()].sort((a, b) => a[0] - b[0])) {
    const x = PAD + column * (NODE_W + COL_GAP)
    const top = PAD + (contentHeight - columnHeight(rows.length)) / 2
    rows.forEach((node, row) => {
      const laid: ChangeMapLayoutNode = {
        id: node.id,
        label: node.label,
        sublabel: node.sublabel,
        kind: node.kind,
        stepId: node.stepId,
        stepBadge: badgeByStep.get(node.stepId) ?? column + 1,
        x,
        y: top + row * (NODE_H + ROW_GAP),
        width: NODE_W,
        height: NODE_H,
      }
      placed.set(node.id, laid)
      nodes.push(laid)
    })
  }

  const columnOf = (id: string): number => columnByStep.get(placed.get(id)?.stepId ?? '') ?? 0
  const edges: ChangeMapLayoutEdge[] = []
  for (const edge of changeMap.edges) {
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    if (!from || !to) continue // validator guarantees endpoints; skip rather than crash
    edges.push(routeEdge(edge, from, to, columnOf(edge.from), columnOf(edge.to)))
  }

  return {
    width: PAD * 2 + stepsInColumnOrder.length * NODE_W + Math.max(0, stepsInColumnOrder.length - 1) * COL_GAP,
    height: PAD * 2 + contentHeight,
    nodes,
    edges,
    ariaLabel,
  }
}

function rightMid(node: ChangeMapLayoutNode): Point {
  return { x: node.x + node.width, y: node.y + node.height / 2 }
}
function leftMid(node: ChangeMapLayoutNode): Point {
  return { x: node.x, y: node.y + node.height / 2 }
}
function topMid(node: ChangeMapLayoutNode): Point {
  return { x: node.x + node.width / 2, y: node.y }
}
function bottomMid(node: ChangeMapLayoutNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height }
}

function routeEdge(
  edge: ChangeMap['edges'][number],
  from: ChangeMapLayoutNode,
  to: ChangeMapLayoutNode,
  fromColumn: number,
  toColumn: number,
): ChangeMapLayoutEdge {
  let start: Point
  let end: Point
  let c1: Point
  let c2: Point
  let labelX: number
  let labelY: number

  if (fromColumn !== toColumn) {
    // Horizontal S-curve. Exit toward the target's side so the arrow always
    // enters a node face, even for a backward (right-to-left) reference.
    const forward = fromColumn < toColumn
    start = forward ? rightMid(from) : leftMid(from)
    end = forward ? leftMid(to) : rightMid(to)
    const dx = end.x - start.x
    c1 = { x: start.x + dx / 2, y: start.y }
    c2 = { x: end.x - dx / 2, y: end.y }
    labelX = (start.x + end.x) / 2
    labelY = (start.y + end.y) / 2 - LABEL_LIFT
  } else {
    // Same column — a vertical curve between the two stacked nodes.
    const downward = to.y > from.y
    start = downward ? bottomMid(from) : topMid(from)
    end = downward ? topMid(to) : bottomMid(to)
    const dy = end.y - start.y
    c1 = { x: start.x, y: start.y + dy / 2 }
    c2 = { x: end.x, y: end.y - dy / 2 }
    labelX = start.x + LABEL_NUDGE
    labelY = (start.y + end.y) / 2
  }

  return {
    from: edge.from,
    to: edge.to,
    label: edge.label,
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    labelX,
    labelY,
  }
}
