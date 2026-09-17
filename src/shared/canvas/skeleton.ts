// The projection between the scene an editor holds and the small format an
// agent reads and writes.
//
// The two are deliberately not the same shape. A live element carries bindings,
// seeds, nonces, fractional indexes and a bound label that lives as a separate
// element pointing back at its container — all of it necessary, none of it
// something a language model gets right by hand. So the skeleton names the
// shapes an arrow joins, folds a label into the shape that carries it, and
// rounds coordinates to integers; the worker turns that back into real geometry.
//
// Everything here is total and silent: validation returns errors, it never
// throws, because the caller is a tool handler that has to answer with words the
// agent can act on rather than a stack trace.

import type {
  CanvasEditRequest,
  CanvasElement,
  CanvasError,
  CanvasSkeleton,
  CanvasSkeletonType,
} from './types'
import { canvasError } from './types'
import { isRecord } from '../records'

/** Past this, an edit is a scene import and belongs in `canvas.import`. */
export const CANVAS_MAX_CREATES_PER_EDIT = 500

export const CANVAS_SKELETON_TYPES: readonly CanvasSkeletonType[] = [
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'frame',
]

const SKELETON_TYPE_SET = new Set<string>(CANVAS_SKELETON_TYPES)

/** Style values the editor itself defaults to; omitted from a skeleton. */
export const CANVAS_STYLE_DEFAULTS = {
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeStyle: 'solid',
  strokeWidth: 2,
  roughness: 1,
  opacity: 100,
} as const

const FILL_STYLES = ['solid', 'hachure', 'cross-hatch'] as const
const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const
const TEXT_ALIGNS = ['left', 'center', 'right'] as const
const FONT_FAMILIES = ['hand', 'normal', 'code'] as const

/**
 * The editor's numeric font families, named. The numbers are the file format's,
 * not ours: the two hand-drawn families share a name because an agent choosing
 * a font is choosing a voice — drawn, plain or monospaced — and not a typeface.
 * Anything unrecognised reads as hand-drawn, which is the board's default look.
 */
const FONT_FAMILY_BY_NUMBER = new Map<number, (typeof FONT_FAMILIES)[number]>([
  [1, 'hand'],
  [5, 'hand'],
  [2, 'normal'],
  [6, 'normal'],
  [3, 'code'],
  [8, 'code'],
])

export function canvasFontFamilyName(value: number | undefined): (typeof FONT_FAMILIES)[number] {
  if (typeof value !== 'number') return 'hand'
  return FONT_FAMILY_BY_NUMBER.get(value) ?? 'hand'
}

/** An element's axis-aligned box, with absent geometry read as zero. */
export function canvasElementBox(element: CanvasElement): {
  x: number
  y: number
  width: number
  height: number
} {
  return {
    x: finite(element.x),
    y: finite(element.y),
    width: finite(element.width),
    height: finite(element.height),
  }
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function round(value: unknown): number {
  return Math.round(finite(value))
}

/**
 * A scene read once, so the four readers over it (skeleton, describe, find,
 * lint) do not each walk it building the same maps.
 */
export type CanvasSceneIndex = {
  /** Every element, deleted ones included — a binding can point at a tombstone. */
  byId: Map<string, CanvasElement>
  /** Live elements in scene order. */
  live: CanvasElement[]
  /** Container id → the text element bound into it. */
  boundTextByContainer: Map<string, CanvasElement>
  /** Text elements folded into a container, so a reader can skip them. */
  foldedTextIds: Set<string>
}

export function indexScene(elements: CanvasElement[]): CanvasSceneIndex {
  const byId = new Map<string, CanvasElement>()
  for (const element of elements) {
    if (!byId.has(element.id)) byId.set(element.id, element)
  }
  const live = elements.filter((element) => element.isDeleted !== true)
  const boundTextByContainer = new Map<string, CanvasElement>()
  const foldedTextIds = new Set<string>()
  for (const element of live) {
    if (element.type !== 'text') continue
    const containerId = element.containerId
    if (typeof containerId !== 'string') continue
    const container = byId.get(containerId)
    // A label whose container is gone is not folded anywhere; it stays visible
    // as its own element so the agent can see the orphan and delete it.
    if (!container || container.isDeleted === true) continue
    if (!boundTextByContainer.has(containerId)) boundTextByContainer.set(containerId, element)
    foldedTextIds.add(element.id)
  }
  return { byId, live, boundTextByContainer, foldedTextIds }
}

/** The text an element reads as: its bound label, its own text, or a frame name. */
export function canvasElementLabel(element: CanvasElement, index: CanvasSceneIndex): string {
  const bound = index.boundTextByContainer.get(element.id)
  if (bound) return textOf(bound)
  if (element.type === 'frame') return typeof element.name === 'string' ? element.name : ''
  return textOf(element)
}

function textOf(element: CanvasElement): string {
  if (typeof element.originalText === 'string') return element.originalText
  return typeof element.text === 'string' ? element.text : ''
}

/**
 * Project live elements to the agent format.
 *
 * Elements of a kind an agent cannot author — freehand strokes, images, embeds —
 * are left out rather than mistyped; `describeScene` still counts and lists them
 * so nobody is editing around something they cannot see.
 */
export function toSkeleton(elements: CanvasElement[]): CanvasSkeleton[] {
  const index = indexScene(elements)
  const childrenByFrame = new Map<string, string[]>()
  for (const element of index.live) {
    const frameId = element.frameId
    if (typeof frameId !== 'string' || !frameId) continue
    const list = childrenByFrame.get(frameId)
    if (list) list.push(element.id)
    else childrenByFrame.set(frameId, [element.id])
  }

  const out: CanvasSkeleton[] = []
  for (const element of index.live) {
    if (index.foldedTextIds.has(element.id)) continue
    if (!SKELETON_TYPE_SET.has(element.type)) continue
    out.push(skeletonOf(element, index, childrenByFrame))
  }
  return out
}

function skeletonOf(
  element: CanvasElement,
  index: CanvasSceneIndex,
  childrenByFrame: Map<string, string[]>,
): CanvasSkeleton {
  const type = element.type as CanvasSkeletonType
  const skeleton: CanvasSkeleton = { id: element.id, type, x: round(element.x), y: round(element.y) }
  const width = round(element.width)
  const height = round(element.height)
  if (width !== 0) skeleton.width = width
  if (height !== 0) skeleton.height = height

  const label = canvasElementLabel(element, index)
  if (label) skeleton.text = label

  // Font settings come from whichever element actually carries the text, so a
  // shape's skeleton describes the label the person sees on it.
  const textSource = index.boundTextByContainer.get(element.id) ?? (element.type === 'text' ? element : null)
  if (textSource) {
    if (typeof textSource.fontSize === 'number') skeleton.fontSize = textSource.fontSize
    if (typeof textSource.fontFamily === 'number') skeleton.fontFamily = canvasFontFamilyName(textSource.fontFamily)
    const align = textSource.textAlign
    if (typeof align === 'string' && (TEXT_ALIGNS as readonly string[]).includes(align)) {
      skeleton.textAlign = align as CanvasSkeleton['textAlign']
    }
  }

  if (type === 'arrow' || type === 'line') applyLinear(skeleton, element)
  if (type === 'frame') {
    if (typeof element.name === 'string' && element.name) skeleton.name = element.name
    const children = childrenByFrame.get(element.id)
    if (children && children.length > 0) skeleton.children = children
  }

  applyStyle(skeleton, element)
  if (element.roundness != null) skeleton.rounded = true
  if (element.locked === true) skeleton.locked = true
  const groupIds = element.groupIds
  if (Array.isArray(groupIds) && typeof groupIds[0] === 'string') skeleton.groupId = groupIds[0]
  return skeleton
}

function applyLinear(skeleton: CanvasSkeleton, element: CanvasElement): void {
  const start = element.startBinding
  const end = element.endBinding
  if (isRecord(start) && typeof start.elementId === 'string') skeleton.startElementId = start.elementId
  if (isRecord(end) && typeof end.elementId === 'string') skeleton.endElementId = end.elementId
  if (element.elbowed === true) skeleton.elbowed = true

  const points = Array.isArray(element.points) ? element.points : []
  // A two-point arrow between two bound shapes is fully described by the pair
  // it joins, and its points are the worker's business — emitting them invites
  // an agent to copy them back and pin the arrow where the shapes no longer are.
  const bound = skeleton.startElementId !== undefined && skeleton.endElementId !== undefined
  if (points.length > 2 || !bound) {
    const x = finite(element.x)
    const y = finite(element.y)
    skeleton.points = points.map((point) => {
      const px = Array.isArray(point) ? finite(point[0]) : 0
      const py = Array.isArray(point) ? finite(point[1]) : 0
      return [Math.round(x + px), Math.round(y + py)] as [number, number]
    })
  }

  const defaultEnd = skeleton.type === 'arrow' ? 'arrow' : null
  if (element.startArrowhead !== undefined && element.startArrowhead !== null) {
    skeleton.startArrowhead = element.startArrowhead
  }
  if (element.endArrowhead !== undefined && element.endArrowhead !== defaultEnd) {
    skeleton.endArrowhead = element.endArrowhead
  }
}

// Only what differs from the editor's own default is emitted: the skeleton is
// read inside an agent's context window, and a board of eighty shapes each
// restating the same seven default values is most of a page of nothing.
function applyStyle(skeleton: CanvasSkeleton, element: CanvasElement): void {
  if (typeof element.strokeColor === 'string' && element.strokeColor !== CANVAS_STYLE_DEFAULTS.strokeColor) {
    skeleton.strokeColor = element.strokeColor
  }
  if (
    typeof element.backgroundColor === 'string' &&
    element.backgroundColor !== CANVAS_STYLE_DEFAULTS.backgroundColor
  ) {
    skeleton.backgroundColor = element.backgroundColor
  }
  const fillStyle = element.fillStyle
  if (
    typeof fillStyle === 'string' &&
    fillStyle !== CANVAS_STYLE_DEFAULTS.fillStyle &&
    (FILL_STYLES as readonly string[]).includes(fillStyle)
  ) {
    skeleton.fillStyle = fillStyle as CanvasSkeleton['fillStyle']
  }
  const strokeStyle = element.strokeStyle
  if (
    typeof strokeStyle === 'string' &&
    strokeStyle !== CANVAS_STYLE_DEFAULTS.strokeStyle &&
    (STROKE_STYLES as readonly string[]).includes(strokeStyle)
  ) {
    skeleton.strokeStyle = strokeStyle as CanvasSkeleton['strokeStyle']
  }
  if (typeof element.strokeWidth === 'number' && element.strokeWidth !== CANVAS_STYLE_DEFAULTS.strokeWidth) {
    skeleton.strokeWidth = element.strokeWidth
  }
  if (typeof element.roughness === 'number' && element.roughness !== CANVAS_STYLE_DEFAULTS.roughness) {
    skeleton.roughness = element.roughness
  }
  if (typeof element.opacity === 'number' && element.opacity !== CANVAS_STYLE_DEFAULTS.opacity) {
    skeleton.opacity = element.opacity
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type FieldRule =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'nullableString' }
  | { kind: 'stringArray' }
  | { kind: 'points' }
  | { kind: 'enum'; values: readonly string[] }

const SKELETON_RULES: Record<string, FieldRule> = {
  id: { kind: 'string' },
  tempId: { kind: 'string' },
  type: { kind: 'enum', values: CANVAS_SKELETON_TYPES },
  x: { kind: 'number' },
  y: { kind: 'number' },
  width: { kind: 'number' },
  height: { kind: 'number' },
  text: { kind: 'string' },
  startElementId: { kind: 'string' },
  endElementId: { kind: 'string' },
  points: { kind: 'points' },
  elbowed: { kind: 'boolean' },
  startArrowhead: { kind: 'nullableString' },
  endArrowhead: { kind: 'nullableString' },
  strokeColor: { kind: 'string' },
  backgroundColor: { kind: 'string' },
  fillStyle: { kind: 'enum', values: FILL_STYLES },
  strokeStyle: { kind: 'enum', values: STROKE_STYLES },
  strokeWidth: { kind: 'number' },
  roughness: { kind: 'number' },
  opacity: { kind: 'number' },
  fontSize: { kind: 'number' },
  fontFamily: { kind: 'enum', values: FONT_FAMILIES },
  textAlign: { kind: 'enum', values: TEXT_ALIGNS },
  rounded: { kind: 'boolean' },
  locked: { kind: 'boolean' },
  children: { kind: 'stringArray' },
  name: { kind: 'string' },
  groupId: { kind: 'string' },
}

/** Fields an update may not set: an element's identity and kind are fixed. */
const PATCH_FORBIDDEN = new Set(['id', 'tempId', 'type'])

export type ValidateSkeletonOptions = {
  /** An update's `set` block: no identity fields, and nothing is required. */
  partial?: boolean
  /** How the field is named in the message, e.g. `create[2]`. */
  label?: string
}

/**
 * Check one skeleton. Returns every problem found rather than the first, so an
 * agent that got three fields wrong fixes three fields in one turn.
 */
export function validateSkeleton(input: unknown, options: ValidateSkeletonOptions = {}): CanvasError[] {
  const label = options.label ?? 'element'
  const errors: CanvasError[] = []
  if (!isRecord(input)) {
    return [canvasError('invalid_edit', `${label} must be an object.`)]
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    const rule = SKELETON_RULES[key]
    if (!rule) {
      errors.push(
        canvasError(
          'invalid_edit',
          `${label} has an unknown field "${key}". Known fields: ${Object.keys(SKELETON_RULES).join(', ')}.`,
        ),
      )
      continue
    }
    if (options.partial && PATCH_FORBIDDEN.has(key)) {
      errors.push(canvasError('invalid_edit', `${label} must not set "${key}" — it is fixed for the element's life.`))
      continue
    }
    const problem = checkField(`${label}.${key}`, rule, value)
    if (problem) errors.push(problem)
  }
  if (!options.partial) {
    if (typeof (input as CanvasSkeleton).type !== 'string') {
      errors.push(canvasError('invalid_edit', `${label}.type is required, one of ${CANVAS_SKELETON_TYPES.join(', ')}.`))
    }
    for (const axis of ['x', 'y'] as const) {
      if (typeof (input as Record<string, unknown>)[axis] !== 'number') {
        errors.push(canvasError('invalid_edit', `${label}.${axis} is required and must be a finite number.`))
      }
    }
  }
  return errors
}

function checkField(where: string, rule: FieldRule, value: unknown): CanvasError | null {
  switch (rule.kind) {
    case 'string':
      return typeof value === 'string' ? null : canvasError('invalid_edit', `${where} must be a string.`)
    case 'nullableString':
      return value === null || typeof value === 'string'
        ? null
        : canvasError('invalid_edit', `${where} must be a string or null.`)
    case 'boolean':
      return typeof value === 'boolean' ? null : canvasError('invalid_edit', `${where} must be true or false.`)
    case 'number':
      // NaN and Infinity survive JSON only as a caller's arithmetic mistake, and
      // either one poisons every geometry read downstream.
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : canvasError('invalid_edit', `${where} must be a finite number.`)
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value)
        ? null
        : canvasError('invalid_edit', `${where} must be one of ${rule.values.join(', ')}.`)
    case 'stringArray': {
      if (!Array.isArray(value)) return canvasError('invalid_edit', `${where} must be an array of ids.`)
      return value.every((entry) => typeof entry === 'string')
        ? null
        : canvasError('invalid_edit', `${where} must contain ids only.`)
    }
    case 'points': {
      if (!Array.isArray(value)) return canvasError('invalid_edit', `${where} must be an array of [x, y] pairs.`)
      for (let i = 0; i < value.length; i += 1) {
        const point = value[i]
        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          !point.every((n) => typeof n === 'number' && Number.isFinite(n))
        ) {
          return canvasError('invalid_edit', `${where}[${i}] must be a pair of finite numbers.`)
        }
      }
      return null
    }
    default:
      return null
  }
}

const EDIT_KEYS = new Set(['delete', 'update', 'create'])

/**
 * Check a whole edit against the scene it will be applied to.
 *
 * `existingIds` is the board's current id set: an id the scene does not hold is
 * refused here as `unknown_element` rather than silently skipped, because an
 * agent working from a stale read needs to know its picture is out of date. A
 * reference to a `tempId` created in the same request is fine — that is what
 * tempIds are for.
 */
export function validateEditRequest(input: unknown, existingIds: Iterable<string>): CanvasError[] {
  if (!isRecord(input)) return [canvasError('invalid_edit', 'An edit must be an object.')]
  const errors: CanvasError[] = []
  for (const key of Object.keys(input)) {
    if (!EDIT_KEYS.has(key)) {
      errors.push(canvasError('invalid_edit', `An edit has an unknown field "${key}". Known fields: delete, update, create.`))
    }
  }
  const known = new Set(existingIds)
  const request = input as CanvasEditRequest

  if (request.delete !== undefined) {
    if (!Array.isArray(request.delete)) {
      errors.push(canvasError('invalid_edit', 'edit.delete must be an array of ids.'))
    } else {
      request.delete.forEach((id, i) => {
        if (typeof id !== 'string') {
          errors.push(canvasError('invalid_edit', `delete[${i}] must be an id string.`))
        } else if (!known.has(id)) {
          errors.push(canvasError('unknown_element', `delete[${i}] names ${id}, which is not on this board.`))
        }
      })
    }
  }

  if (request.update !== undefined) {
    if (!Array.isArray(request.update)) {
      errors.push(canvasError('invalid_edit', 'edit.update must be an array of { id, set } entries.'))
    } else {
      request.update.forEach((entry, i) => {
        const label = `update[${i}]`
        if (!isRecord(entry)) {
          errors.push(canvasError('invalid_edit', `${label} must be an object with id and set.`))
          return
        }
        for (const key of Object.keys(entry)) {
          if (key !== 'id' && key !== 'set') {
            errors.push(canvasError('invalid_edit', `${label} has an unknown field "${key}". Known fields: id, set.`))
          }
        }
        if (typeof entry.id !== 'string') {
          errors.push(canvasError('invalid_edit', `${label}.id must be an id string.`))
        } else if (!known.has(entry.id)) {
          errors.push(canvasError('unknown_element', `${label}.id names ${entry.id}, which is not on this board.`))
        }
        if (entry.set === undefined) {
          errors.push(canvasError('invalid_edit', `${label}.set is required.`))
        } else {
          errors.push(...validateSkeleton(entry.set, { partial: true, label: `${label}.set` }))
        }
      })
    }
  }

  const tempIds = new Set<string>()
  if (request.create !== undefined) {
    if (!Array.isArray(request.create)) {
      errors.push(canvasError('invalid_edit', 'edit.create must be an array of elements.'))
    } else {
      if (request.create.length > CANVAS_MAX_CREATES_PER_EDIT) {
        errors.push(
          canvasError(
            'invalid_edit',
            `An edit may create at most ${CANVAS_MAX_CREATES_PER_EDIT} elements; this one creates ${request.create.length}. Build the board section by section.`,
          ),
        )
      }
      request.create.forEach((entry, i) => {
        const label = `create[${i}]`
        errors.push(...validateSkeleton(entry, { label }))
        if (!isRecord(entry)) return
        const tempId = entry.tempId
        if (typeof tempId === 'string') {
          if (tempIds.has(tempId)) {
            errors.push(canvasError('invalid_edit', `${label}.tempId "${tempId}" is used twice in this edit.`))
          }
          tempIds.add(tempId)
        }
      })
    }
  }

  // References resolve against the board or against a tempId minted anywhere in
  // the same request, so an agent may draw the arrow before the box it points at.
  const resolvable = (id: string): boolean => known.has(id) || tempIds.has(id)
  const checkRefs = (entry: unknown, label: string): void => {
    if (!isRecord(entry)) return
    for (const field of ['startElementId', 'endElementId'] as const) {
      const value = entry[field]
      if (typeof value === 'string' && !resolvable(value)) {
        errors.push(
          canvasError('unknown_element', `${label}.${field} names ${value}, which is neither on this board nor a tempId in this edit.`),
        )
      }
    }
    const children = entry.children
    if (Array.isArray(children)) {
      children.forEach((child, i) => {
        if (typeof child === 'string' && !resolvable(child)) {
          errors.push(
            canvasError('unknown_element', `${label}.children[${i}] names ${child}, which is neither on this board nor a tempId in this edit.`),
          )
        }
      })
    }
  }
  if (Array.isArray(request.create)) request.create.forEach((entry, i) => checkRefs(entry, `create[${i}]`))
  if (Array.isArray(request.update)) {
    request.update.forEach((entry, i) => {
      if (isRecord(entry)) checkRefs(entry.set, `update[${i}].set`)
    })
  }

  return errors
}
