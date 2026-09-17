// `apply-edit`: an agent's small format turned into real geometry.
//
// The order is fixed — delete, then update, then create — because each phase
// changes what the next one can see, and an agent that deletes a box and draws
// a new one in the same request means exactly that.
//
// Everything that has to be re-derived is re-derived here, not left to the
// editor to fix later: a shape that moved drags its label with it and re-routes
// every arrow fastened to it; a shape that is deleted leaves a tombstone, loses
// its label and is detached from the arrows that pointed at it, which stay where
// they were with a null binding rather than vanishing. The array that comes back
// is the whole scene, tombstones included, with a bumped version on precisely
// the elements that changed — see versioning.ts for why that matters.

import type {
  CanvasEditRequest,
  CanvasEditResult,
  CanvasElement,
  CanvasPoint,
  CanvasSkeleton,
  CanvasSkeletonPatch,
  CanvasSkeletonType,
} from '../../../shared/canvas/types'
import type { CanvasWorkerRequestOf } from '../../../shared/canvas/worker-protocol'
import { canvasFontFamilyName } from '../../../shared/canvas/skeleton'
import { isRecord } from '../../../shared/records'
import type { CanvasEditorBridge } from './editorBridge'
import { CanvasWorkerError } from './errors'
import { absolutePoints, arrowGeometry, boxOf, centreOf, edgePoint, CANVAS_ARROW_GAP } from './geometry'
import type { ArrowEnd, Box } from './geometry'
import { canvasRoundness, carryFrom, patchNeedsRebuild, toLibrarySkeleton } from './skeletonMap'
import type { LibrarySkeleton, SkeletonCarry } from './skeletonMap'
import { SceneDraft, stampVersion } from './versioning'
import type { Stamp } from './versioning'

export type ApplyEditOutcome = {
  elements: CanvasElement[]
  /**
   * Every id whose version this request moved, the ones nobody asked about
   * included. `result.updated` is the agent's own list; this is what the
   * service needs to know whether the person was drawing on the same element.
   */
  changed: string[]
  files: Record<string, unknown>
  result: CanvasEditResult
}

/** Fields an update can set without anything else having to be recomputed. */
const STYLE_KEYS = [
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeStyle',
  'strokeWidth',
  'roughness',
  'opacity',
  'startArrowhead',
  'endArrowhead',
] as const

const LINEAR_TYPES: ReadonlySet<string> = new Set(['arrow', 'line'])

type BatchKind = 'create' | 'rebuild' | 'passthrough'

type BatchEntry = {
  id: string
  kind: BatchKind
  type: CanvasSkeletonType | string
  /** The agent-facing description this element is rebuilt from. */
  skeleton?: CanvasSkeleton
  /** The element being replaced, when there is one. */
  base?: CanvasElement
  labelId?: string | null
  /** A label this element used to carry under a different id. */
  strandedLabelId?: string | null
  startId?: string | null
  endId?: string | null
  children?: string[]
  /** Filled in once the skeleton is built, so arrows can aim at real boxes. */
  box?: Box
  library?: LibrarySkeleton
}

export function applyEdit(
  bridge: CanvasEditorBridge,
  request: CanvasWorkerRequestOf<'apply-edit'>,
): ApplyEditOutcome {
  const stamp: Stamp = { now: bridge.now, nonce: bridge.nonce }
  const draft = new SceneDraft(request.elements)
  const warnings: string[] = []
  const edit: CanvasEditRequest = request.edit ?? {}

  const deleted = runDeletes(draft, edit.delete ?? [], stamp, warnings)
  const creates = edit.create ?? []
  const mintedIds = creates.map(() => bridge.newId())
  const tempIds: Record<string, string> = {}
  creates.forEach((skeleton, at) => {
    if (typeof skeleton.tempId === 'string' && skeleton.tempId) tempIds[skeleton.tempId] = mintedIds[at]
  })
  const batch = new Map<string, BatchEntry>()

  const styleUpdated = runStyleUpdates(draft, edit.update ?? [], stamp, warnings)
  collectRebuilds(draft, edit.update ?? [], batch, warnings)
  collectCreates(draft, creates, mintedIds, batch, warnings)
  cascadeFrames(draft, batch, stamp)
  resolveReferences(draft, batch, tempIds, warnings)
  cascadeArrows(draft, batch)

  const created: string[] = []
  const updated = new Set<string>(styleUpdated)
  if (batch.size > 0) {
    runConversion(bridge, draft, batch, stamp, warnings, created, updated)
  }

  detachRepointed(draft, batch, stamp, updated)
  releaseDroppedChildren(draft, batch, stamp, updated)
  repairTouched(draft, stamp, warnings)

  return {
    elements: draft.all(),
    // Read after every pass, repairs included: the draft hands back the object
    // it was given for anything untouched, so this is exactly the set whose
    // version moved.
    changed: draft.changedIds(),
    files: request.files ?? {},
    result: {
      created,
      updated: [...updated].filter((id) => !isBoundLabel(draft, id) && !created.includes(id)),
      deleted,
      tempIds,
      warnings,
    },
  }
}

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

function runDeletes(draft: SceneDraft, ids: string[], stamp: Stamp, warnings: string[]): string[] {
  const deleted: string[] = []
  for (const id of ids) {
    const element = draft.get(id)
    if (!element) {
      throw new CanvasWorkerError('unknown_element', `${id} is not on this board, so it cannot be deleted.`)
    }
    if (element.isDeleted === true) {
      warnings.push(`${id} was already deleted; the tombstone was left as it was.`)
      continue
    }
    draft.patch(id, { isDeleted: true }, stamp)
    deleted.push(id)

    const label = findLabel(draft, id)
    if (label) draft.patch(label.id, { isDeleted: true }, stamp)

    detach(draft, id, stamp)
  }
  return deleted
}

/**
 * Take a deleted element out of everything that referred to it.
 *
 * An arrow bound to a deleted shape is NOT deleted with it: it stays where it
 * was with that end unfastened, because an agent that deleted one box of three
 * has not said anything about the arrows, and silently removing them loses work
 * the tombstone cannot bring back.
 */
function detach(draft: SceneDraft, deletedId: string, stamp: Stamp): void {
  for (const element of draft.all()) {
    if (element.id === deletedId) continue
    const updates: Partial<CanvasElement> = {}

    const bound = element.boundElements
    if (Array.isArray(bound) && bound.some((ref) => isRecord(ref) && ref.id === deletedId)) {
      updates.boundElements = bound.filter((ref) => !(isRecord(ref) && ref.id === deletedId))
    }
    if (bindingTarget(element, 'startBinding') === deletedId) updates.startBinding = null
    if (bindingTarget(element, 'endBinding') === deletedId) updates.endBinding = null
    if (element.frameId === deletedId) updates.frameId = null
    if (element.containerId === deletedId && element.isDeleted !== true) updates.isDeleted = true

    if (Object.keys(updates).length > 0) draft.patch(element.id, updates, stamp)
  }
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

function runStyleUpdates(
  draft: SceneDraft,
  updates: NonNullable<CanvasEditRequest['update']>,
  stamp: Stamp,
  warnings: string[],
): string[] {
  const touched: string[] = []
  for (const entry of updates) {
    const element = draft.get(entry.id)
    if (!element) {
      throw new CanvasWorkerError('unknown_element', `${entry.id} is not on this board, so it cannot be updated.`)
    }
    if (element.isDeleted === true) {
      warnings.push(`${entry.id} is deleted; the update to it was skipped.`)
      continue
    }
    const patch = entry.set ?? {}
    const changes: Record<string, unknown> = {}
    for (const key of STYLE_KEYS) {
      if (patch[key] !== undefined) changes[key] = patch[key]
    }
    if (patch.rounded !== undefined) changes.roundness = canvasRoundness(element.type, patch.rounded)
    if (patch.groupId !== undefined) changes.groupIds = [patch.groupId]
    if (patch.name !== undefined && element.type === 'frame') changes.name = patch.name
    if (patch.locked !== undefined) changes.locked = patch.locked

    if (Object.keys(changes).length === 0) continue
    draft.patch(entry.id, changes, stamp)
    touched.push(entry.id)

    // A label is part of the shape it sits in: it locks and unlocks with it,
    // and it joins the same group, or a drag of the group leaves it behind.
    const label = findLabel(draft, entry.id)
    if (label) {
      const labelChanges: Partial<CanvasElement> = {}
      if (patch.locked !== undefined) labelChanges.locked = patch.locked
      if (patch.groupId !== undefined) labelChanges.groupIds = [patch.groupId]
      if (Object.keys(labelChanges).length > 0) draft.patch(label.id, labelChanges, stamp)
    }
  }
  return touched
}

function collectRebuilds(
  draft: SceneDraft,
  updates: NonNullable<CanvasEditRequest['update']>,
  batch: Map<string, BatchEntry>,
  warnings: string[],
): void {
  for (const entry of updates) {
    const element = draft.get(entry.id)
    if (!element || element.isDeleted === true) continue
    const patch = entry.set ?? {}
    if (!patchNeedsRebuild(patch as Record<string, unknown>)) continue
    if (!isAuthorable(element.type)) {
      warnings.push(`${entry.id} is a ${element.type}, which this format cannot re-describe; its geometry was left alone.`)
      continue
    }
    addRebuild(draft, element, patch, batch)
  }
}

function addRebuild(
  draft: SceneDraft,
  element: CanvasElement,
  patch: CanvasSkeletonPatch,
  batch: Map<string, BatchEntry>,
): BatchEntry {
  const existing = batch.get(element.id)
  if (existing && existing.kind !== 'passthrough') return existing

  const label = findLabel(draft, element.id)
  const skeleton = { ...describeElement(draft, element, label), ...patch } as CanvasSkeleton
  skeleton.type = element.type as CanvasSkeletonType
  const entry: BatchEntry = {
    id: element.id,
    kind: 'rebuild',
    type: element.type,
    skeleton,
    base: element,
    labelId: skeleton.text ? (label?.id ?? null) : null,
    strandedLabelId: skeleton.text ? null : (label?.id ?? null),
    // From the SKELETON, not from the board: `describeElement` seeded it with
    // what the frame holds now and the patch may have replaced that list, which
    // is the one way an agent moves an element into or out of a frame.
    children: element.type === 'frame' ? (skeleton.children ?? childIdsOf(draft, element.id)) : undefined,
  }
  batch.set(element.id, entry)
  return entry
}

// Every create is given its real id before anything is built, so an arrow drawn
// in the same request can point at a box that does not exist yet.
function collectCreates(
  draft: SceneDraft,
  creates: CanvasSkeleton[],
  mintedIds: string[],
  batch: Map<string, BatchEntry>,
  warnings: string[],
): void {
  creates.forEach((skeleton, at) => {
    const id = mintedIds[at]
    if (!id) return
    if (draft.has(id)) {
      warnings.push(`A created element was given an id already on the board (${id}); it was skipped.`)
      return
    }
    batch.set(id, {
      id,
      kind: 'create',
      type: skeleton.type,
      skeleton,
      labelId: null,
      children: skeleton.type === 'frame' ? (skeleton.children ?? []) : undefined,
    })
  })
}

/** Moving a frame moves what it holds. */
function cascadeFrames(draft: SceneDraft, batch: Map<string, BatchEntry>, stamp: Stamp): void {
  for (const entry of [...batch.values()]) {
    if (entry.kind !== 'rebuild' || entry.type !== 'frame' || !entry.base || !entry.skeleton) continue
    const dx = entry.skeleton.x - num(entry.base.x)
    const dy = entry.skeleton.y - num(entry.base.y)
    if (dx === 0 && dy === 0) continue
    for (const childId of childIdsOf(draft, entry.id)) {
      const child = draft.get(childId)
      if (!child || child.isDeleted === true) continue
      if (!isAuthorable(child.type)) {
        // Not something the skeleton format can re-describe, so it is moved
        // wholesale rather than rebuilt — a frame drag must not drop a stroke.
        draft.patch(childId, { x: num(child.x) + dx, y: num(child.y) + dy }, stamp)
        continue
      }
      addRebuild(draft, child, { x: num(child.x) + dx, y: num(child.y) + dy }, batch)
    }
  }
}

/** Resolve every `startElementId`/`endElementId` in the batch to a real id. */
function resolveReferences(
  draft: SceneDraft,
  batch: Map<string, BatchEntry>,
  tempIds: Record<string, string>,
  warnings: string[],
): void {
  for (const entry of batch.values()) {
    if (!entry.skeleton || !LINEAR_TYPES.has(entry.type)) continue
    entry.startId = resolveRef(draft, batch, tempIds, entry.skeleton.startElementId, entry.id, 'start', warnings)
    entry.endId = resolveRef(draft, batch, tempIds, entry.skeleton.endElementId, entry.id, 'end', warnings)
  }
  // A frame's children, and any label those children carry, have to travel
  // through the conversion with it: the converter walks them to work out where
  // the frame goes, and throws on one it cannot find.
  for (const entry of [...batch.values()]) {
    if (entry.type !== 'frame') continue
    const named = (entry.children ?? []).map((id) => tempIds[id] ?? id)
    const adopted: string[] = []
    for (const id of named) {
      const queued = batch.get(id)
      const existing = draft.get(id)
      if (!queued && (!existing || existing.isDeleted === true)) {
        // Named but not there. Said out loud, because a frame that quietly
        // holds one fewer element than the agent asked for moves without it.
        warnings.push(`${entry.id} names ${id} as a child, which is not on this board; it was left out of the frame.`)
        continue
      }
      adopted.push(id)
    }
    entry.children = adopted
    for (const childId of adopted) {
      addPassthrough(draft, batch, childId)
      const label = findLabel(draft, childId)
      if (label) addPassthrough(draft, batch, label.id)
    }
  }
  // Both ends of every arrow have to be in the same conversion, or the binding
  // is recorded against an element the converter cannot see and is dropped.
  for (const entry of [...batch.values()]) {
    if (entry.startId) addPassthrough(draft, batch, entry.startId)
    if (entry.endId) addPassthrough(draft, batch, entry.endId)
  }
}

/**
 * Which element an arrow's end names, or null with a warning.
 *
 * The kind check applies to a target being created in this same request just as
 * it does to one already on the board, and that is not a nicety: the converter
 * fastens an arrow by looking the target up among the shapes it is building,
 * and an end pointing at a frame, a label or another arrow finds nothing there
 * and throws — taking the whole request down instead of one unfastened end.
 */
function resolveRef(
  draft: SceneDraft,
  batch: Map<string, BatchEntry>,
  tempIds: Record<string, string>,
  ref: string | undefined,
  owner: string,
  which: string,
  warnings: string[],
): string | null {
  if (typeof ref !== 'string' || !ref) return null
  const id = tempIds[ref] ?? ref
  const queued = batch.get(id)
  const existing = draft.get(id)
  if (!queued && (!existing || existing.isDeleted === true)) {
    warnings.push(`The ${which} of ${owner} named ${ref}, which is not on this board; that end was left unfastened.`)
    return null
  }
  // The batch's word is the one that counts: it is what the converter will be
  // handed, and for a create there is nothing on the board to ask.
  const type = String(queued?.type ?? existing?.type ?? '')
  if (type === 'text' || type === 'frame' || LINEAR_TYPES.has(type)) {
    warnings.push(`The ${which} of ${owner} named ${ref}, which is a ${type}; only a shape can hold an arrow.`)
    return null
  }
  return id
}

function addPassthrough(draft: SceneDraft, batch: Map<string, BatchEntry>, id: string): void {
  if (batch.has(id)) return
  const element = draft.get(id)
  if (!element || element.isDeleted === true) return
  batch.set(id, { id, kind: 'passthrough', type: element.type, base: element })
}

/** Every arrow fastened to something the batch rebuilds is re-routed with it. */
function cascadeArrows(draft: SceneDraft, batch: Map<string, BatchEntry>): void {
  const moved = new Set<string>()
  for (const entry of batch.values()) {
    if (entry.kind === 'create' || entry.kind === 'rebuild') moved.add(entry.id)
  }
  if (moved.size === 0) return

  const extra: CanvasElement[] = []
  for (const element of draft.live()) {
    if (element.type !== 'arrow' || batch.has(element.id)) continue
    const start = bindingTarget(element, 'startBinding')
    const end = bindingTarget(element, 'endBinding')
    if ((start && moved.has(start)) || (end && moved.has(end))) extra.push(element)
  }
  for (const element of extra) {
    const entry = addRebuild(draft, element, {}, batch)
    const start = bindingTarget(element, 'startBinding')
    const end = bindingTarget(element, 'endBinding')
    entry.startId = start && draft.get(start)?.isDeleted !== true ? start : null
    entry.endId = end && draft.get(end)?.isDeleted !== true ? end : null
    if (entry.startId) addPassthrough(draft, batch, entry.startId)
    if (entry.endId) addPassthrough(draft, batch, entry.endId)
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function runConversion(
  bridge: CanvasEditorBridge,
  draft: SceneDraft,
  batch: Map<string, BatchEntry>,
  stamp: Stamp,
  warnings: string[],
  created: string[],
  updated: Set<string>,
): void {
  const shapes: LibrarySkeleton[] = []
  const arrows: LibrarySkeleton[] = []
  const frames: LibrarySkeleton[] = []

  // Shapes first, then arrows: an arrow snapshots the shape it fastens to, so
  // a shape whose label has not been bound yet would be captured without it.
  for (const entry of batch.values()) {
    if (entry.kind === 'passthrough') {
      const skeleton = passthroughSkeleton(entry.base!)
      entry.library = skeleton
      entry.box = boxOf(entry.base!)
      shapes.push(skeleton)
      continue
    }
    if (LINEAR_TYPES.has(entry.type) || entry.type === 'frame') continue
    const skeleton = buildSkeleton(draft, entry)
    entry.library = skeleton
    entry.box = skeletonBox(skeleton, entry.type)
    shapes.push(skeleton)
  }

  for (const entry of batch.values()) {
    if (entry.kind === 'passthrough' || !LINEAR_TYPES.has(entry.type)) continue
    const skeleton = buildSkeleton(draft, entry, batch)
    entry.library = skeleton
    arrows.push(skeleton)
  }

  for (const entry of batch.values()) {
    if (entry.kind === 'passthrough' || entry.type !== 'frame') continue
    const skeleton = buildSkeleton(draft, entry)
    entry.library = skeleton
    frames.push(skeleton)
  }

  const produced = bridge.convert([...shapes, ...arrows, ...frames])
  const byId = new Map<string, CanvasElement>()
  for (const element of produced) byId.set(element.id, compact(element))

  for (const entry of batch.values()) {
    const output = byId.get(entry.id)
    if (!output) {
      warnings.push(`The editor did not produce an element for ${entry.id}; it was left unchanged.`)
      continue
    }

    if (entry.kind === 'passthrough') {
      const base = entry.base!
      const updates: Partial<CanvasElement> = {}
      const next = output.boundElements ?? []
      if (JSON.stringify(next) !== JSON.stringify(base.boundElements ?? [])) updates.boundElements = next
      // The other half of a passthrough that matters: a frame adopts an element
      // by writing `frameId` on it, and for an element that already existed
      // this write-back is the only place that lands. Without it the frame
      // reports the child and then moves away without it.
      const adoptedBy = typeof output.frameId === 'string' ? output.frameId : null
      if (adoptedBy !== null && adoptedBy !== base.frameId) updates.frameId = adoptedBy
      if (Object.keys(updates).length > 0) {
        draft.patch(base.id, updates, stamp)
        updated.add(base.id)
      }
      continue
    }

    const base = entry.base
    const fixed: CanvasElement = {
      ...output,
      isDeleted: false,
      // Paint order is the scene's, not this conversion's: an element's own
      // index is kept, and a new element gets none, which leaves it last in
      // the array and therefore on top.
      index: base ? (base.index ?? null) : null,
    }
    restoreFrameBox(fixed, entry)
    draft.put(stampVersion(fixed, base, stamp))
    if (base) updated.add(entry.id)
    else created.push(entry.id)

    reportGrowth(entry, fixed, warnings)
  }

  // The bound labels the conversion produced, which are elements in their own
  // right but never ids the caller asked for.
  for (const element of produced) {
    if (element.type !== 'text' || typeof element.containerId !== 'string') continue
    const entry = batch.get(element.containerId)
    if (!entry || entry.kind === 'passthrough') continue
    const previous = draft.get(element.id)
    // A label is part of the shape it sits in, groups included. The converter
    // does not carry the container's groups onto the label it builds, and a
    // label outside its shape's group is left standing where the shape was the
    // first time the group is dragged.
    const container = draft.get(element.containerId)
    const groupIds = Array.isArray(container?.groupIds)
      ? container.groupIds.filter((id): id is string => typeof id === 'string')
      : []
    const fixed = compact({ ...element, isDeleted: false, index: previous?.index ?? null, groupIds })
    draft.put(stampVersion(fixed, previous, stamp))
    updated.add(element.id)
  }

  // A label the caller emptied out, or one whose container was rebuilt under a
  // new label id, is tombstoned rather than left floating over the board.
  for (const entry of batch.values()) {
    if (!entry.strandedLabelId) continue
    draft.patch(entry.strandedLabelId, { isDeleted: true, containerId: null }, stamp)
  }
}

function buildSkeleton(draft: SceneDraft, entry: BatchEntry, batch?: Map<string, BatchEntry>): LibrarySkeleton {
  const skeleton = entry.skeleton!
  const base = entry.base
  const carry: SkeletonCarry | undefined = base ? carryFrom(base) : undefined
  const label = entry.labelId ? draft.get(entry.labelId) : null
  const labelCarry = label ? carryFrom(label) : undefined

  let linear: { x: number; y: number; points: CanvasPoint[] } | null = null
  if (LINEAR_TYPES.has(entry.type)) {
    linear = routeLinear(draft, entry, batch)
  }

  return toLibrarySkeleton({
    id: entry.id,
    skeleton,
    carry,
    labelId: entry.labelId ?? null,
    labelCarry,
    linear,
    startId: entry.startId ?? null,
    endId: entry.endId ?? null,
    children: entry.children,
  })
}

/**
 * Where a linear element's ends go.
 *
 * A bound end is trimmed to its shape's outline; a free end is whatever the
 * caller gave, or where the element already was. An arrow with neither end
 * bound and no points of its own falls back to the box the skeleton describes.
 */
function routeLinear(
  draft: SceneDraft,
  entry: BatchEntry,
  batch: Map<string, BatchEntry> | undefined,
): { x: number; y: number; points: CanvasPoint[] } | null {
  const skeleton = entry.skeleton!
  // A connector from a shape back to itself. There is no line between a box and
  // itself to trim, so the general routing below produces nothing and the
  // converter falls back to its own default — a 100 by 0 stub at whatever raw
  // coordinates the skeleton happened to carry, drawn across the middle of the
  // shape. An explicit loop is the only reading of "an arrow from A to A".
  if (entry.startId && entry.startId === entry.endId) {
    const box = endBox(draft, batch, entry.startId)
    if (box) return loopAround(box)
  }
  const given = Array.isArray(skeleton.points) ? (skeleton.points as CanvasPoint[]) : null
  const middle = given && given.length > 2 ? given.slice(1, -1) : []

  const start: ArrowEnd = { box: endBox(draft, batch, entry.startId) }
  const end: ArrowEnd = { box: endBox(draft, batch, entry.endId) }
  if (!start.box) start.free = given?.[0] ?? [skeleton.x, skeleton.y]
  if (!end.box) {
    end.free = given?.[given.length - 1] ?? [
      skeleton.x + (skeleton.width ?? 100),
      skeleton.y + (skeleton.height ?? 0),
    ]
  }

  const routed = arrowGeometry(start, end, middle)
  if (routed) return routed
  if (given && given.length >= 2) {
    const [ox, oy] = given[0]
    return { x: ox, y: oy, points: given.map((point) => [point[0] - ox, point[1] - oy] as CanvasPoint) }
  }
  return null
}

/** How far out of its shape a self-loop reaches. */
const SELF_LOOP_REACH = 60

/**
 * A loop off a shape's top-right corner: out of the top, round, and back into
 * the right-hand side. Both ends leave from the shape's own outline, so it
 * reads the same on a diamond or an ellipse as on a box.
 */
function loopAround(box: Box): { x: number; y: number; points: CanvasPoint[] } {
  const [cx, cy] = centreOf(box)
  const top = edgePoint(box, [cx, cy - Math.max(box.height, 1)])
  const right = edgePoint(box, [cx + Math.max(box.width, 1), cy])
  const exit: CanvasPoint = [top[0], top[1] - CANVAS_ARROW_GAP]
  const entry: CanvasPoint = [right[0] + CANVAS_ARROW_GAP, right[1]]
  const reach = Math.max(SELF_LOOP_REACH, Math.min(box.width, box.height) / 2)
  const absolute: CanvasPoint[] = [
    exit,
    [exit[0], exit[1] - reach],
    [entry[0] + reach, exit[1] - reach],
    [entry[0] + reach, entry[1]],
    entry,
  ]
  const [ox, oy] = absolute[0]
  return { x: ox, y: oy, points: absolute.map(([px, py]) => [px - ox, py - oy] as CanvasPoint) }
}

function endBox(
  draft: SceneDraft,
  batch: Map<string, BatchEntry> | undefined,
  id: string | null | undefined,
): Box | null {
  if (!id) return null
  const entry = batch?.get(id)
  if (entry?.box) return entry.box
  const element = draft.get(id)
  return element ? boxOf(element) : null
}

function skeletonBox(skeleton: LibrarySkeleton, type: string): Box {
  return {
    x: num(skeleton.x),
    y: num(skeleton.y),
    width: num(skeleton.width),
    height: num(skeleton.height),
    type,
  }
}

/**
 * An existing element, handed to the converter as itself.
 *
 * The converter only fastens an arrow to a shape it can see in the same call,
 * so a shape an arrow points at has to travel with it. What comes back for one
 * of these is read for exactly one field — the arrow it gained in
 * `boundElements` — and never written over the original, which is how a shape
 * an edit did not touch keeps its own version.
 */
function passthroughSkeleton(element: CanvasElement): LibrarySkeleton {
  const copy: LibrarySkeleton = { ...element }
  delete copy.isDeleted
  return copy
}

/**
 * The converter reads a frame's own x/y/width/height with `||`, so a frame
 * sitting at zero on either axis would be moved to its children's bounds. What
 * the skeleton asked for is put back.
 */
function restoreFrameBox(element: CanvasElement, entry: BatchEntry): void {
  if (entry.type !== 'frame' || !entry.library) return
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = entry.library[key]
    if (typeof value === 'number' && Number.isFinite(value)) element[key] = value
  }
}

function reportGrowth(entry: BatchEntry, produced: CanvasElement, warnings: string[]): void {
  const asked = entry.skeleton
  if (!asked || !asked.text) return
  const width = num(produced.width)
  const height = num(produced.height)
  const grewWidth = asked.width !== undefined && width > asked.width + 1
  const grewHeight = asked.height !== undefined && height > asked.height + 1
  if (!grewWidth && !grewHeight) return
  warnings.push(
    `The label on ${entry.id} did not fit, so the shape grew to ${Math.round(width)}x${Math.round(height)} ` +
      `from ${Math.round(asked.width ?? width)}x${Math.round(asked.height ?? height)}. Shorten the text or ask for a bigger shape.`,
  )
}

/**
 * A connector pointed somewhere else.
 *
 * A binding is a pair of references, and rebuilding the arrow rewrites only the
 * arrow's half: the shape it used to name still lists it. That reads as a
 * permanent one-way binding no skeleton edit can clear, and the old shape drags
 * an arrow that is not attached to it. `repairTouched` adds the missing half of
 * a binding; this removes the half that is left over.
 */
function detachRepointed(
  draft: SceneDraft,
  batch: Map<string, BatchEntry>,
  stamp: Stamp,
  updated: Set<string>,
): void {
  for (const entry of batch.values()) {
    if (entry.kind !== 'rebuild' || !LINEAR_TYPES.has(entry.type) || !entry.base) continue
    const nowBound = new Set(
      [entry.startId, entry.endId].filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
    for (const which of ['startBinding', 'endBinding'] as const) {
      const was = bindingTarget(entry.base, which)
      if (!was || nowBound.has(was)) continue
      const target = draft.get(was)
      if (!target || target.isDeleted === true) continue
      const bound = Array.isArray(target.boundElements) ? target.boundElements : []
      const kept = bound.filter((ref) => !(isRecord(ref) && ref.id === entry.id))
      if (kept.length === bound.length) continue
      draft.patch(was, { boundElements: kept }, stamp)
      updated.add(was)
    }
  }
}

/**
 * An element a rebuilt frame no longer lists.
 *
 * It still names the frame in its own `frameId`, and the converter has no
 * reason to say otherwise — it was never handed the element. So the release is
 * made here rather than hoped for: a frame this request rebuilt holds the
 * children it was asked for, and nothing else follows it around the board.
 */
function releaseDroppedChildren(
  draft: SceneDraft,
  batch: Map<string, BatchEntry>,
  stamp: Stamp,
  updated: Set<string>,
): void {
  for (const entry of batch.values()) {
    if (entry.kind !== 'rebuild' || entry.type !== 'frame') continue
    const kept = new Set(entry.children ?? [])
    for (const element of draft.live()) {
      if (element.frameId !== entry.id || kept.has(element.id)) continue
      // A bound label belongs to its container, which belongs to the frame; it
      // is never named in a children list and must not be released on its own.
      if (typeof element.containerId === 'string' && element.containerId) continue
      draft.patch(element.id, { frameId: null }, stamp)
      updated.add(element.id)
    }
  }
}

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

/**
 * The narrow repair pass.
 *
 * Deliberately not `restoreElements`: that walks the whole scene, drops
 * anything it considers invisibly small — a tombstone among them — and
 * rewrites bindings in place without a version to show for it, which is
 * precisely the phantom change the merge cannot tell from a real one. This
 * only looks at what this request touched.
 */
function repairTouched(draft: SceneDraft, stamp: Stamp, warnings: string[]): void {
  for (const id of draft.changedIds()) {
    const element = draft.get(id)
    if (!element || element.isDeleted === true) continue
    const updates: Partial<CanvasElement> = {}

    for (const which of ['startBinding', 'endBinding'] as const) {
      const targetId = bindingTarget(element, which)
      if (!targetId) continue
      const target = draft.get(targetId)
      if (!target || target.isDeleted === true) {
        updates[which] = null
        warnings.push(`${id} was bound to ${targetId}, which is not on the board; that end was unfastened.`)
        continue
      }
      // The other half of the pair: the shape has to list the arrow, or it will
      // be left behind the first time somebody drags it.
      const bound = Array.isArray(target.boundElements) ? target.boundElements : []
      if (!bound.some((ref) => isRecord(ref) && ref.id === id)) {
        draft.patch(targetId, { boundElements: [...bound, { id, type: 'arrow' }] }, stamp)
      }
    }

    const bound = element.boundElements
    if (Array.isArray(bound)) {
      const kept = bound.filter((ref) => {
        if (!isRecord(ref) || typeof ref.id !== 'string') return false
        const target = draft.get(ref.id)
        return target !== undefined && target.isDeleted !== true
      })
      if (kept.length !== bound.length) updates.boundElements = kept
    }

    if (Object.keys(updates).length > 0) draft.patch(id, updates, stamp)
  }
}

// ---------------------------------------------------------------------------
// Reading the scene
// ---------------------------------------------------------------------------

/** The agent-facing description of an element, as the basis for a rebuild. */
function describeElement(draft: SceneDraft, element: CanvasElement, label: CanvasElement | null): CanvasSkeleton {
  const skeleton: CanvasSkeleton = {
    id: element.id,
    type: element.type as CanvasSkeletonType,
    x: num(element.x),
    y: num(element.y),
  }
  if (num(element.width) !== 0) skeleton.width = num(element.width)
  if (num(element.height) !== 0) skeleton.height = num(element.height)

  const textSource = label ?? (element.type === 'text' ? element : null)
  if (textSource) {
    const text = typeof textSource.originalText === 'string' ? textSource.originalText : textSource.text
    if (typeof text === 'string' && text) skeleton.text = text
    if (typeof textSource.fontSize === 'number') skeleton.fontSize = textSource.fontSize
    skeleton.fontFamily = canvasFontFamilyName(textSource.fontFamily)
    const align = textSource.textAlign
    if (align === 'left' || align === 'center' || align === 'right') skeleton.textAlign = align
  }

  const fields = skeleton as Record<string, unknown>
  for (const key of STYLE_KEYS) {
    const value = element[key]
    if (value !== undefined && value !== null) fields[key] = value
  }
  if (element.roundness != null) skeleton.rounded = true
  else skeleton.rounded = false
  if (element.locked === true) skeleton.locked = true
  const groupIds = element.groupIds
  if (Array.isArray(groupIds) && typeof groupIds[0] === 'string') skeleton.groupId = groupIds[0]

  if (LINEAR_TYPES.has(element.type)) {
    const start = bindingTarget(element, 'startBinding')
    const end = bindingTarget(element, 'endBinding')
    if (start) skeleton.startElementId = start
    if (end) skeleton.endElementId = end
    if (element.elbowed === true) skeleton.elbowed = true
    skeleton.points = absolutePoints(element)
  }
  if (element.type === 'frame') {
    if (typeof element.name === 'string') skeleton.name = element.name
    skeleton.children = childIdsOf(draft, element.id)
  }
  return skeleton
}

function childIdsOf(draft: SceneDraft, frameId: string): string[] {
  return draft
    .live()
    .filter((element) => element.frameId === frameId && typeof element.containerId !== 'string')
    .map((element) => element.id)
}

function findLabel(draft: SceneDraft, containerId: string): CanvasElement | null {
  for (const element of draft.all()) {
    if (element.type !== 'text' || element.isDeleted === true) continue
    if (element.containerId === containerId) return element
  }
  return null
}

function isBoundLabel(draft: SceneDraft, id: string): boolean {
  const element = draft.get(id)
  return Boolean(element && element.type === 'text' && typeof element.containerId === 'string' && element.containerId)
}

function bindingTarget(element: CanvasElement, which: 'startBinding' | 'endBinding'): string | null {
  const binding = element[which]
  return isRecord(binding) && typeof binding.elementId === 'string' ? binding.elementId : null
}

const AUTHORABLE: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'frame',
])

function isAuthorable(type: string): boolean {
  return AUTHORABLE.has(type)
}

/** Drop keys the converter left undefined, so two elements compare honestly. */
function compact(element: CanvasElement): CanvasElement {
  const out: CanvasElement = { ...element }
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key]
  }
  return out
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
