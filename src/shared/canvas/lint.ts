// The board's own review pass.
//
// An agent draws blind: it places a box at a coordinate and has no way to see
// that the label overflows it, that the arrow it drew ends in mid-air, or that
// two shapes are sitting on top of each other. This is the feedback loop that
// replaces looking — describe, edit, lint, and redraw the section that scored
// badly rather than nudging coordinates until the number moves.
//
// Every rule here is deliberately conservative. A false positive costs an agent
// a redraw of something that was already fine, which is worse than missing one
// crooked arrow, so anything that could plausibly be intentional is left alone:
// a shape fully inside another is a zone, a shape and its own label are one
// object, an arrow crossing the box it is fastened to is how arrows work.
//
// It also has to be CHEAP, because it runs on the main thread, on every edit,
// and on a read-only describe that an agent may call in a loop. Three of the
// rules are about pairs of elements, and a pile of six thousand overlapping
// shapes is eighteen million pairs and about as many issue objects. So the
// pairwise rules are bucketed into a uniform grid (two elements that could be
// within the cramped distance of each other always share a cell), collection
// stops dead at a cap, and a shared budget ends the scan rather than letting
// one pathological board block the process. A report that stopped early says
// so instead of looking like a clean board.

import type { CanvasElement, CanvasLintIssue, CanvasLintReport, CanvasLintSeverity } from './types'
import { canvasElementBox, indexScene } from './skeleton'
import type { CanvasSceneIndex } from './skeleton'
import { isRecord } from '../records'

/** Beyond this the report is noise; the count of the rest still reaches the agent. */
export const CANVAS_LINT_MAX_ISSUES = 50

/**
 * Where collecting stops. Past this an issue is counted rather than described —
 * and past a few dozen the score has bottomed out anyway, so the extra objects
 * buy nothing and a dense board would allocate millions of them.
 */
export const CANVAS_LINT_COLLECT_LIMIT = 200

/**
 * How many candidate pairs the pairwise rules may look at, between them, before
 * the scan gives up and says so. It is the one bound that holds whatever shape
 * the board is in: the grid makes a normal large board cheap, and this makes a
 * pathological one finite.
 */
export const CANVAS_LINT_PAIR_BUDGET = 1_000_000

/** What each severity costs the score. */
export const CANVAS_LINT_SEVERITY_WEIGHT: Record<CanvasLintSeverity, number> = { high: 10, medium: 4, low: 1 }

/** Closer than this and two shapes read as one smudge. */
export const CANVAS_LINT_CRAMPED_GAP = 40

/** Shorter than this and an arrow reads as a tick between two touching shapes. */
export const CANVAS_LINT_SHORT_ARROW = 80

/** Two arrow ends closer than this in focus are aimed at the same spot. */
export const CANVAS_LINT_FOCUS_EPSILON = 0.05

/** The grid's cell, in scene pixels: a few default nodes across. */
const GRID_CELL = 256

/**
 * An element whose box covers more cells than this is not worth indexing —
 * a page-sized frame would be written into thousands of them. It is compared
 * against everything instead, which is what the budget is there to bound.
 */
const GRID_MAX_CELLS_PER_ELEMENT = 256

type Box = { x: number; y: number; width: number; height: number }

const LINEAR_TYPES = new Set(['arrow', 'line'])

/**
 * Where the rules put what they find, and what stops them.
 *
 * One object rather than an array so that "the report is full" and "the scan
 * ran out of budget" are answerable from inside a loop — the difference
 * between a report that is short because the board is good and one that is
 * short because nobody looked.
 */
type Sink = {
  issues: CanvasLintIssue[]
  /** Issues seen after the collection limit; counted, not kept. */
  overflow: number
  /** Set when a rule stopped early, so `omitted` is a floor rather than a total. */
  truncated: boolean
  notes: string[]
  budget: number
}

function record(sink: Sink, issue: CanvasLintIssue): void {
  if (sink.issues.length < CANVAS_LINT_COLLECT_LIMIT) {
    sink.issues.push(issue)
    return
  }
  sink.overflow += 1
  sink.truncated = true
}

/**
 * Whether the report is full, and so whether the rule asking should stop.
 *
 * Asking marks the report truncated, because a rule that stops here has not
 * finished looking: `omitted` becomes a floor and the score an upper bound. A
 * board that happens to end on exactly the limit is reported the same way,
 * which over-states by nothing a caller can act on — "at least this many" is
 * true either way.
 */
function full(sink: Sink): boolean {
  if (sink.issues.length < CANVAS_LINT_COLLECT_LIMIT) return false
  sink.truncated = true
  return true
}

/** One candidate pair's worth of budget. False once there is none left. */
function spend(sink: Sink): boolean {
  if (sink.budget <= 0) return false
  sink.budget -= 1
  return true
}

const BUDGET_NOTE =
  'This board is large enough that the overlap, arrow-tip and fan-in checks stopped early. Lint a region of it by drawing the section on its own board, or reduce the number of elements.'

function outOfBudget(sink: Sink): void {
  if (sink.truncated && sink.notes.includes(BUDGET_NOTE)) return
  sink.truncated = true
  if (!sink.notes.includes(BUDGET_NOTE)) sink.notes.push(BUDGET_NOTE)
}

export function lintScene(elements: CanvasElement[]): CanvasLintReport {
  const index = indexScene(elements)
  const sink: Sink = { issues: [], overflow: 0, truncated: false, notes: [], budget: CANVAS_LINT_PAIR_BUDGET }

  duplicateIds(elements, sink)
  danglingBindings(index, sink)
  oneWayBindings(index, sink)
  textOverflow(index, sink)
  proximity(index, sink)
  arrowRules(index, sink)
  fanIn(index, sink)

  sink.issues.sort(compareIssues)
  const penalty = sink.issues.reduce((sum, issue) => sum + CANVAS_LINT_SEVERITY_WEIGHT[issue.severity], 0)
  const omitted = Math.max(0, sink.issues.length - CANVAS_LINT_MAX_ISSUES) + sink.overflow
  return {
    score: Math.max(0, 100 - penalty),
    issues: sink.issues.slice(0, CANVAS_LINT_MAX_ISSUES),
    omitted,
    ...(sink.truncated ? { truncated: true } : {}),
    ...(sink.notes.length > 0 ? { notes: sink.notes } : {}),
  }
}

const SEVERITY_ORDER: Record<CanvasLintSeverity, number> = { high: 0, medium: 1, low: 2 }

function compareIssues(a: CanvasLintIssue, b: CanvasLintIssue): number {
  if (a.severity !== b.severity) return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  if (a.type !== b.type) return a.type < b.type ? -1 : 1
  const left = a.elementIds.join(',')
  const right = b.elementIds.join(',')
  return left < right ? -1 : left > right ? 1 : 0
}

// --- identity ---------------------------------------------------------------

function duplicateIds(elements: CanvasElement[], sink: Sink): void {
  const counts = new Map<string, number>()
  for (const element of elements) counts.set(element.id, (counts.get(element.id) ?? 0) + 1)
  for (const [id, count] of counts) {
    if (count < 2) continue
    record(sink, {
      type: 'duplicate_id',
      severity: 'high',
      elementIds: [id],
      detail: `Id ${id} appears ${count} times. Every merge and every binding resolves it to one element, so the others are unreachable.`,
    })
  }
}

// --- bindings ---------------------------------------------------------------

function bindingTarget(element: CanvasElement, which: 'startBinding' | 'endBinding'): string | null {
  const binding = element[which]
  return isRecord(binding) && typeof binding.elementId === 'string' ? binding.elementId : null
}

function isMissing(index: CanvasSceneIndex, id: string): boolean {
  const target = index.byId.get(id)
  return !target || target.isDeleted === true
}

function danglingBindings(index: CanvasSceneIndex, sink: Sink): void {
  for (const element of index.live) {
    if (full(sink)) return
    for (const which of ['startBinding', 'endBinding'] as const) {
      const target = bindingTarget(element, which)
      if (target && isMissing(index, target)) {
        record(sink, {
          type: 'dangling_binding',
          severity: 'high',
          elementIds: [element.id, target],
          detail: `${element.type} ${element.id} is bound at its ${which === 'startBinding' ? 'start' : 'end'} to ${target}, which is not on the board. The end will not follow anything.`,
        })
      }
    }
    const containerId = element.containerId
    if (typeof containerId === 'string' && containerId && isMissing(index, containerId)) {
      record(sink, {
        type: 'dangling_binding',
        severity: 'high',
        elementIds: [element.id, containerId],
        detail: `Text ${element.id} names container ${containerId}, which is not on the board. The label floats free.`,
      })
    }
  }
}

function boundElementIds(element: CanvasElement): string[] {
  const bound = element.boundElements
  if (!Array.isArray(bound)) return []
  return bound.filter(isRecord).map((entry) => entry.id).filter((id): id is string => typeof id === 'string')
}

/**
 * A binding is a pair of references: the arrow names the shape, and the shape
 * lists the arrow. Only one of the two is what an agent that hand-wrote geometry
 * leaves behind, and the editor honours whichever half it reads first — so the
 * arrow follows the shape but not the drag, or the other way round.
 */
function oneWayBindings(index: CanvasSceneIndex, sink: Sink): void {
  for (const element of index.live) {
    if (full(sink)) return
    for (const which of ['startBinding', 'endBinding'] as const) {
      const targetId = bindingTarget(element, which)
      if (!targetId) continue
      const target = index.byId.get(targetId)
      if (!target || target.isDeleted === true) continue
      if (!boundElementIds(target).includes(element.id)) {
        record(sink, {
          type: 'one_way_binding',
          severity: 'medium',
          elementIds: [element.id, targetId],
          detail: `${element.id} binds to ${targetId}, but ${targetId} does not list it in boundElements. Dragging ${targetId} will leave the arrow behind.`,
        })
      }
    }

    const containerId = element.containerId
    if (typeof containerId === 'string' && containerId) {
      const container = index.byId.get(containerId)
      if (container && container.isDeleted !== true && !boundElementIds(container).includes(element.id)) {
        record(sink, {
          type: 'one_way_binding',
          severity: 'medium',
          elementIds: [element.id, containerId],
          detail: `Label ${element.id} names container ${containerId}, but ${containerId} does not list it. The label will not move with the shape.`,
        })
      }
    }

    // The other direction: a shape that lists an arrow the arrow knows nothing about.
    for (const boundId of boundElementIds(element)) {
      const bound = index.byId.get(boundId)
      if (!bound || bound.isDeleted === true) continue
      if (bound.type === 'text') {
        if (bound.containerId !== element.id) {
          record(sink, {
            type: 'one_way_binding',
            severity: 'medium',
            elementIds: [element.id, boundId],
            detail: `${element.id} lists label ${boundId}, but that text names a different container.`,
          })
        }
        continue
      }
      const names =
        bindingTarget(bound, 'startBinding') === element.id || bindingTarget(bound, 'endBinding') === element.id
      if (!names) {
        record(sink, {
          type: 'one_way_binding',
          severity: 'medium',
          elementIds: [element.id, boundId],
          detail: `${element.id} lists ${boundId} in boundElements, but ${boundId} is not bound to it at either end.`,
        })
      }
    }
  }
}

// --- text -------------------------------------------------------------------

/**
 * Whether a label still fits the shape it sits in. The width estimate is
 * deliberately crude — 0.6 em per character plus the editor's padding — because
 * this runs with no DOM and no font metrics; it is a smell detector, not a
 * layout engine, so it only fires when the overflow is not marginal.
 */
function textOverflow(index: CanvasSceneIndex, sink: Sink): void {
  for (const [containerId, text] of index.boundTextByContainer) {
    if (full(sink)) return
    const container = index.byId.get(containerId)
    if (!container || container.isDeleted === true) continue
    const box = canvasElementBox(container)
    if (box.width <= 0 || box.height <= 0) continue
    const content = typeof text.originalText === 'string' ? text.originalText : String(text.text ?? '')
    if (!content) continue
    const fontSize = typeof text.fontSize === 'number' && Number.isFinite(text.fontSize) ? text.fontSize : 20
    const lines = content.split('\n')
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
    const estimatedWidth = longest * fontSize * 0.6 + 16
    const estimatedHeight = lines.length * fontSize * 1.25
    if (estimatedWidth > box.width) {
      record(sink, {
        type: 'text_overflow',
        severity: 'medium',
        elementIds: [containerId, text.id],
        detail: `The label on ${containerId} needs about ${Math.round(estimatedWidth)}px but the shape is ${Math.round(box.width)}px wide. Widen the shape or shorten the label.`,
      })
    } else if (estimatedHeight > box.height) {
      record(sink, {
        type: 'text_overflow',
        severity: 'medium',
        elementIds: [containerId, text.id],
        detail: `The label on ${containerId} needs about ${Math.round(estimatedHeight)}px of height but the shape is ${Math.round(box.height)}px tall.`,
      })
    }
  }
}

// --- geometry ---------------------------------------------------------------

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  )
}

function gapBetween(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)))
  return Math.hypot(dx, dy)
}

function sharesGroup(a: CanvasElement, b: CanvasElement): boolean {
  const left = Array.isArray(a.groupIds) ? a.groupIds : []
  const right = Array.isArray(b.groupIds) ? b.groupIds : []
  return left.some((groupId) => typeof groupId === 'string' && right.includes(groupId))
}

/**
 * Pairs that look like a collision but are how the board is meant to be drawn.
 * Geometry is axis-aligned and `angle` is ignored: a rotated shape's box is an
 * over-estimate, which can only make this more forgiving, never less.
 */
function intentionalPair(a: CanvasElement, b: CanvasElement, index: CanvasSceneIndex): boolean {
  // A shape and its own label are one object.
  if (index.boundTextByContainer.get(a.id)?.id === b.id) return true
  if (index.boundTextByContainer.get(b.id)?.id === a.id) return true
  if (a.containerId === b.id || b.containerId === a.id) return true
  // A frame and what it holds.
  if (a.frameId === b.id || b.frameId === a.id) return true
  // An arrow and the shapes it is fastened to.
  if (bindingTarget(a, 'startBinding') === b.id || bindingTarget(a, 'endBinding') === b.id) return true
  if (bindingTarget(b, 'startBinding') === a.id || bindingTarget(b, 'endBinding') === a.id) return true

  const boxA = canvasElementBox(a)
  const boxB = canvasElementBox(b)
  // One shape wholly inside another is a zone, a background or a group's
  // container — never an accident worth reporting.
  if (contains(boxA, boxB) || contains(boxB, boxA)) return true
  // Grouping is somebody stating that these shapes are one thing; whatever they
  // arranged inside the group, they arranged on purpose.
  if (sharesGroup(a, b)) return true
  return false
}

/** The half-open range of grid cells a box, grown by `pad`, covers. */
type Span = { minCol: number; minRow: number; maxCol: number; maxRow: number }

function spanOf(box: Box, pad: number): Span | null {
  const minCol = Math.floor((box.x - pad) / GRID_CELL)
  const minRow = Math.floor((box.y - pad) / GRID_CELL)
  const maxCol = Math.floor((box.x + box.width + pad) / GRID_CELL)
  const maxRow = Math.floor((box.y + box.height + pad) / GRID_CELL)
  if (![minCol, minRow, maxCol, maxRow].every(Number.isFinite)) return null
  const cells = (maxCol - minCol + 1) * (maxRow - minRow + 1)
  // A box spread over more cells than this costs more to index than it saves.
  if (!Number.isFinite(cells) || cells > GRID_MAX_CELLS_PER_ELEMENT) return null
  return { minCol, minRow, maxCol, maxRow }
}

function cellKey(col: number, row: number): string {
  return `${col},${row}`
}

/**
 * A uniform grid over a set of boxes, plus the ones too big to index.
 *
 * Two boxes that overlap share at least one cell, because any point of their
 * intersection lies in exactly one cell that both of them cover. Growing each
 * box by half the cramped distance before indexing extends that to "two boxes
 * closer than the cramped distance", which is the whole of what `proximity`
 * asks.
 */
type Grid = {
  cells: Map<string, number[]>
  spans: Array<Span | null>
  /** Indices of the boxes not in any cell; every rule checks them by hand. */
  oversized: number[]
}

function buildGrid(boxes: Array<Box | null>, pad: number): Grid {
  const cells = new Map<string, number[]>()
  const spans: Array<Span | null> = []
  const oversized: number[] = []
  boxes.forEach((box, at) => {
    const span = box ? spanOf(box, pad) : null
    spans.push(span)
    if (!box) return
    if (!span) {
      oversized.push(at)
      return
    }
    for (let col = span.minCol; col <= span.maxCol; col += 1) {
      for (let row = span.minRow; row <= span.maxRow; row += 1) {
        const key = cellKey(col, row)
        const bucket = cells.get(key)
        if (bucket) bucket.push(at)
        else cells.set(key, [at])
      }
    }
  })
  return { cells, spans, oversized }
}

/**
 * Whether this cell is where a pair is allowed to be compared.
 *
 * Two boxes can share several cells, and comparing them in each one would
 * report the same overlap repeatedly. The top-left cell of the cells they
 * share is picked, which is O(1) and needs no memory of what has been seen.
 */
function isCanonicalCell(a: Span, b: Span, col: number, row: number): boolean {
  return col === Math.max(a.minCol, b.minCol) && row === Math.max(a.minRow, b.minRow)
}

function proximity(index: CanvasSceneIndex, sink: Sink): void {
  const subjects = index.live.filter((element) => !index.foldedTextIds.has(element.id))
  // A box with no area says nothing about where its element is, so it is left
  // out of the grid entirely rather than being compared and skipped.
  const boxes = subjects.map((element) => {
    const box = canvasElementBox(element)
    return box.width > 0 && box.height > 0 ? box : null
  })
  const grid = buildGrid(boxes, CANVAS_LINT_CRAMPED_GAP / 2)

  const judge = (i: number, j: number): void => {
    const a = subjects[i]
    const b = subjects[j]
    // Two linear elements crossing is how a diagram routes; their boxes say
    // nothing about their ink, so the pair is not judged on boxes at all.
    if (LINEAR_TYPES.has(a.type) && LINEAR_TYPES.has(b.type)) return
    if (intentionalPair(a, b, index)) return
    const boxA = boxes[i]
    const boxB = boxes[j]
    if (!boxA || !boxB) return
    if (overlaps(boxA, boxB)) {
      record(sink, {
        type: 'overlap',
        severity: 'medium',
        elementIds: [a.id, b.id].sort(),
        detail: `${a.id} and ${b.id} overlap. Move one aside or make the containment deliberate by putting one fully inside the other.`,
      })
      return
    }
    const gap = gapBetween(boxA, boxB)
    if (gap > 0 && gap < CANVAS_LINT_CRAMPED_GAP) {
      record(sink, {
        type: 'cramped',
        severity: 'low',
        elementIds: [a.id, b.id].sort(),
        detail: `${a.id} and ${b.id} are ${Math.round(gap)}px apart; below ${CANVAS_LINT_CRAMPED_GAP}px they read as one shape.`,
      })
    }
  }

  for (const [key, bucket] of grid.cells) {
    if (full(sink)) return
    const [col, row] = key.split(',').map(Number)
    for (let a = 0; a < bucket.length; a += 1) {
      for (let b = a + 1; b < bucket.length; b += 1) {
        const i = bucket[a]
        const j = bucket[b]
        const spanI = grid.spans[i]
        const spanJ = grid.spans[j]
        if (!spanI || !spanJ || !isCanonicalCell(spanI, spanJ, col, row)) continue
        if (!spend(sink)) {
          outOfBudget(sink)
          return
        }
        judge(i, j)
        if (full(sink)) return
      }
    }
  }

  // The ones too big to index: compared against everything, once each.
  for (const i of grid.oversized) {
    for (let j = 0; j < subjects.length; j += 1) {
      if (j === i || !boxes[j]) continue
      // Two oversized boxes are a pair twice over; judged from the lower index.
      if (grid.spans[j] === null && j < i) continue
      if (!spend(sink)) {
        outOfBudget(sink)
        return
      }
      judge(i, j)
      if (full(sink)) return
    }
  }
}

function absolutePoints(element: CanvasElement): Array<[number, number]> {
  const points = Array.isArray(element.points) ? element.points : []
  const { x, y } = canvasElementBox(element)
  return points
    .filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2)
    .map((point) => [x + Number(point[0] ?? 0), y + Number(point[1] ?? 0)] as [number, number])
}

function arrowRules(index: CanvasSceneIndex, sink: Sink): void {
  // The shapes an arrow tip could be sitting inside, indexed by where they are:
  // a tip is one point, and one point falls in exactly one cell, so only the
  // shapes registered in that cell (plus the oversized ones) can hold it.
  const targets = index.live.filter(
    (element) =>
      !LINEAR_TYPES.has(element.type) && element.type !== 'frame' && !index.foldedTextIds.has(element.id),
  )
  const targetBoxes = targets.map((element) => {
    const box = canvasElementBox(element)
    return box.width > 0 && box.height > 0 ? box : null
  })
  const grid = buildGrid(targetBoxes, 0)

  for (const element of index.live) {
    if (full(sink)) return
    if (element.type !== 'arrow') continue
    const points = absolutePoints(element)
    const box = canvasElementBox(element)
    const first = points[0] ?? [box.x, box.y]
    const last = points[points.length - 1] ?? [box.x + box.width, box.y + box.height]
    const length = Math.hypot(last[0] - first[0], last[1] - first[1])
    if (length > 0 && length < CANVAS_LINT_SHORT_ARROW) {
      record(sink, {
        type: 'short_arrow',
        severity: 'low',
        elementIds: [element.id],
        detail: `Arrow ${element.id} is ${Math.round(length)}px long; below ${CANVAS_LINT_SHORT_ARROW}px its head and tail are hard to tell apart. Move the shapes further apart.`,
      })
    }

    const boundIds = new Set(
      [bindingTarget(element, 'startBinding'), bindingTarget(element, 'endBinding')].filter(
        (id): id is string => typeof id === 'string',
      ),
    )
    for (const [tip, end] of [
      [first, 'start'],
      [last, 'end'],
    ] as Array<[[number, number], string]>) {
      if (!Number.isFinite(tip[0]) || !Number.isFinite(tip[1])) continue
      const bucket = grid.cells.get(cellKey(Math.floor(tip[0] / GRID_CELL), Math.floor(tip[1] / GRID_CELL))) ?? []
      for (const at of [...bucket, ...grid.oversized]) {
        const candidate = targets[at]
        if (boundIds.has(candidate.id)) continue
        const target = targetBoxes[at]
        if (!target) continue
        if (!spend(sink)) {
          outOfBudget(sink)
          return
        }
        if (tip[0] > target.x && tip[0] < target.x + target.width && tip[1] > target.y && tip[1] < target.y + target.height) {
          record(sink, {
            type: 'arrow_tip_inside_shape',
            severity: 'medium',
            elementIds: [element.id, candidate.id],
            detail: `The ${end} of arrow ${element.id} sits inside ${candidate.id} without being bound to it. Bind it, or stop the arrow at the edge.`,
          })
          if (full(sink)) return
        }
      }
    }
  }
}

/**
 * Several arrows landing on one shape from different places, all aimed at the
 * same point on it, arrive as one thick smudge instead of a fan. Kept low
 * severity and narrow — the far ends must also be on the same side of the
 * target, or a genuine converging fan from opposite sides would be flagged.
 */
function fanIn(index: CanvasSceneIndex, sink: Sink): void {
  const byTarget = new Map<string, CanvasElement[]>()
  for (const element of index.live) {
    if (element.type !== 'arrow') continue
    const targetId = bindingTarget(element, 'endBinding')
    if (!targetId) continue
    const list = byTarget.get(targetId)
    if (list) list.push(element)
    else byTarget.set(targetId, [element])
  }

  for (const [targetId, arrows] of byTarget) {
    if (full(sink)) return
    const target = index.byId.get(targetId)
    if (!target || target.isDeleted === true) continue
    const centre = boxCentre(canvasElementBox(target))
    for (let i = 0; i < arrows.length; i += 1) {
      for (let j = i + 1; j < arrows.length; j += 1) {
        if (!spend(sink)) {
          outOfBudget(sink)
          return
        }
        const a = arrows[i]
        const b = arrows[j]
        const aSource = bindingTarget(a, 'startBinding')
        const bSource = bindingTarget(b, 'startBinding')
        if (aSource && bSource && aSource === bSource) continue
        const aFocus = focusOf(a, 'endBinding')
        const bFocus = focusOf(b, 'endBinding')
        if (Math.abs(aFocus - bFocus) >= CANVAS_LINT_FOCUS_EPSILON) continue
        if (farSide(a, centre) !== farSide(b, centre)) continue
        record(sink, {
          type: 'fan_in_same_focus',
          severity: 'low',
          elementIds: [a.id, b.id, targetId].sort(),
          detail: `Arrows ${a.id} and ${b.id} both land on ${targetId} at the same point from the same side. Spread their focus so the fan reads.`,
        })
        if (full(sink)) return
      }
    }
  }
}

function focusOf(element: CanvasElement, which: 'startBinding' | 'endBinding'): number {
  const binding = element[which]
  return isRecord(binding) && typeof binding.focus === 'number' && Number.isFinite(binding.focus) ? binding.focus : 0
}

function boxCentre(box: Box): [number, number] {
  return [box.x + box.width / 2, box.y + box.height / 2]
}

// Which quadrant the arrow comes from, relative to the target's centre. Two
// arrows sharing a quadrant and a focus are landing in the same place.
function farSide(arrow: CanvasElement, centre: [number, number]): string {
  const points = absolutePoints(arrow)
  const box = canvasElementBox(arrow)
  const start = points[0] ?? [box.x, box.y]
  return `${start[0] < centre[0] ? 'w' : 'e'}${start[1] < centre[1] ? 'n' : 's'}`
}
