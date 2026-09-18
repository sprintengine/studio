// `layout`: the seven arranging operations.
//
// The three that move things (align, distribute, stack) compute coordinates and
// then hand them to the same update path an agent's own edit takes, so a shape
// arranged by the tool drags its label and re-routes its arrows exactly as a
// shape moved by hand does. The four that do not move anything (group, ungroup,
// lock, unlock) are field changes, and touch the bound labels too — a label
// left out of its shape's group is left behind the first time the group moves.

import type { CanvasElement, CanvasLayoutRequest } from '../../../shared/canvas/types'
import type { CanvasWorkerRequestOf } from '../../../shared/canvas/worker-protocol'
import type { CanvasEditorBridge } from './editorBridge'
import { applyEdit } from './applyEdit'
import { CanvasWorkerError } from './errors'
import { innermostSharedGroup, layoutMoves } from './layoutMath'
import type { LayoutBox } from './layoutMath'
import { SceneDraft } from './versioning'
import type { Stamp } from './versioning'

export type ApplyLayoutOutcome = {
  elements: CanvasElement[]
  /** Every id whose version moved; the service tests these for a collision. */
  changed: string[]
  /**
   * What the operation could not do. An align over a freehand stroke or an
   * image moves nothing — the skeleton format cannot re-describe those — and
   * answering "done" to that is how a board ends up crooked with no sign why.
   */
  warnings: string[]
}

export function applyLayout(bridge: CanvasEditorBridge, request: CanvasWorkerRequestOf<'layout'>): ApplyLayoutOutcome {
  const layout = request.request
  const draft = new SceneDraft(request.elements)
  const stamp: Stamp = { now: bridge.now, nonce: bridge.nonce }
  const subjects = resolve(draft, layout.elementIds)

  switch (layout.op) {
    case 'align':
    case 'distribute':
    case 'stack':
      return move(bridge, request, subjects, layout)
    case 'group':
      return fromDraft(draft, group(draft, subjects, bridge, stamp))
    case 'ungroup':
      return fromDraft(draft, ungroup(draft, subjects, stamp))
    case 'lock':
      return fromDraft(draft, setLocked(draft, subjects, true, stamp))
    case 'unlock':
      return fromDraft(draft, setLocked(draft, subjects, false, stamp))
    default:
      throw new CanvasWorkerError('invalid_edit', `Unknown layout operation "${String(layout.op)}".`)
  }
}

/** The field-changing operations all end the same way: the draft says what moved. */
function fromDraft(draft: SceneDraft, elements: CanvasElement[]): ApplyLayoutOutcome {
  return { elements, changed: draft.changedIds(), warnings: [] }
}

function resolve(draft: SceneDraft, ids: string[]): CanvasElement[] {
  const out: CanvasElement[] = []
  for (const id of ids ?? []) {
    const element = draft.get(id)
    if (!element || element.isDeleted === true) {
      throw new CanvasWorkerError('unknown_element', `${id} is not on this board.`)
    }
    out.push(element)
  }
  if (out.length === 0) {
    throw new CanvasWorkerError('invalid_edit', 'A layout operation needs at least one element to work on.')
  }
  return out
}

function move(
  bridge: CanvasEditorBridge,
  request: CanvasWorkerRequestOf<'layout'>,
  subjects: CanvasElement[],
  layout: CanvasLayoutRequest,
): ApplyLayoutOutcome {
  const boxes: LayoutBox[] = subjects.map((element) => ({
    id: element.id,
    x: num(element.x),
    y: num(element.y),
    width: num(element.width),
    height: num(element.height),
  }))
  const moves = layoutMoves(boxes, layout).filter((next) => {
    const box = boxes.find((candidate) => candidate.id === next.id)
    return box !== undefined && (Math.abs(box.x - next.x) > 0.01 || Math.abs(box.y - next.y) > 0.01)
  })
  if (moves.length === 0) return { elements: request.elements, changed: [], warnings: [] }

  const outcome = applyEdit(bridge, {
    kind: 'apply-edit',
    requestId: request.requestId,
    elements: request.elements,
    files: {},
    edit: { update: moves.map((next) => ({ id: next.id, set: { x: next.x, y: next.y } })) },
  })
  // The edit's warnings are this operation's warnings: an element it could not
  // re-describe is an element this align or stack did not move.
  return { elements: outcome.elements, changed: outcome.changed, warnings: outcome.result.warnings }
}

function group(
  draft: SceneDraft,
  subjects: CanvasElement[],
  bridge: CanvasEditorBridge,
  stamp: Stamp,
): CanvasElement[] {
  const groupId = bridge.newId()
  for (const element of subjects) {
    // Appended, not replaced: groups nest, and the new one is the outermost.
    addGroup(draft, element.id, groupId, stamp)
    for (const label of labelsOf(draft, element.id)) addGroup(draft, label.id, groupId, stamp)
  }
  return draft.all()
}

function addGroup(draft: SceneDraft, id: string, groupId: string, stamp: Stamp): void {
  const element = draft.get(id)
  if (!element) return
  const current = Array.isArray(element.groupIds) ? element.groupIds.filter((v) => typeof v === 'string') : []
  if (current.includes(groupId)) return
  draft.patch(id, { groupIds: [...current, groupId] }, stamp)
}

function ungroup(draft: SceneDraft, subjects: CanvasElement[], stamp: Stamp): CanvasElement[] {
  const lists = subjects.map((element) =>
    Array.isArray(element.groupIds) ? element.groupIds.filter((v): v is string => typeof v === 'string') : [],
  )
  const groupId = innermostSharedGroup(lists)
  if (!groupId) {
    throw new CanvasWorkerError('invalid_edit', 'Those elements are not in a group together.')
  }
  // Everything in the group leaves it, not only what the caller named: a group
  // half of whose members still carry the id is a group that still exists.
  for (const element of draft.live()) {
    const current = Array.isArray(element.groupIds) ? element.groupIds.filter((v) => typeof v === 'string') : []
    if (!current.includes(groupId)) continue
    draft.patch(element.id, { groupIds: current.filter((id) => id !== groupId) }, stamp)
  }
  return draft.all()
}

function setLocked(draft: SceneDraft, subjects: CanvasElement[], locked: boolean, stamp: Stamp): CanvasElement[] {
  for (const element of subjects) {
    draft.patch(element.id, { locked }, stamp)
    for (const label of labelsOf(draft, element.id)) draft.patch(label.id, { locked }, stamp)
  }
  return draft.all()
}

function labelsOf(draft: SceneDraft, containerId: string): CanvasElement[] {
  return draft.live().filter((element) => element.type === 'text' && element.containerId === containerId)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
