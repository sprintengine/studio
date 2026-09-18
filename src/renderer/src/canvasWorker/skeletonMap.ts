// The agent format, translated into the one the editor package's converter
// takes. Pure on purpose: nothing here imports the editor, so the translation
// is unit-testable in plain Node while the call that consumes it is not.
//
// The two formats overlap but do not agree. A skeleton names a font family
// ('hand'), the file format numbers it (5). A skeleton says `rounded: true`,
// the format wants a roundness *algorithm* whose right value depends on the
// shape. A skeleton folds a label into the shape that carries it, the converter
// wants it under a `label` key. And a skeleton names the shapes an arrow joins,
// which is handled a layer up — here we only carry the resolved ids through.

import type {
  CanvasBoundElementRef,
  CanvasElement,
  CanvasPoint,
  CanvasSkeleton,
  CanvasSkeletonType,
} from '../../../shared/canvas/types'

/** What the converter takes: a loose record, so this file needs no editor types. */
export type LibrarySkeleton = Record<string, unknown>

/**
 * The file format's numeric families, by the three voices a skeleton can ask
 * for. These are the families the editor itself gives new elements in 0.18:
 * Excalifont (the hand-drawn default), Nunito (plain) and Comic Shanns (the
 * monospaced one). `src/shared/canvas/skeleton.ts` maps them back.
 */
export const CANVAS_FONT_FAMILY_ID: Record<NonNullable<CanvasSkeleton['fontFamily']>, number> = {
  hand: 5,
  normal: 6,
  code: 8,
}

/** The CSS family name each numeric id resolves to, for the font preload. */
export const CANVAS_FONT_FAMILY_NAME: Record<number, string> = {
  5: 'Excalifont',
  6: 'Nunito',
  8: 'Comic Shanns',
}

export const CANVAS_DEFAULT_FONT_SIZE = 20

/** What an empty frame is given when the caller named no size. */
export const CANVAS_DEFAULT_FRAME_WIDTH = 400
export const CANVAS_DEFAULT_FRAME_HEIGHT = 300

/** The editor's own padding between a label and the shape that holds it. */
export const CANVAS_BOUND_TEXT_PADDING = 5

/** The roundness algorithms the file format numbers. */
const ROUNDNESS_ADAPTIVE = 3
const ROUNDNESS_PROPORTIONAL = 2

/** Line height per line, as the editor measures its own families. */
const LINE_HEIGHT_RATIO = 1.25

/** Width of one character as a fraction of the font size, over-estimated. */
const CHAR_WIDTH_RATIO = 0.6

const GEOMETRY_KEYS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'width',
  'height',
  'text',
  'fontSize',
  'fontFamily',
  'textAlign',
  'points',
  'startElementId',
  'endElementId',
  'elbowed',
  'children',
])

/**
 * Whether a patch changes anything the editor has to re-derive.
 *
 * A colour is a field; a coordinate is a fact other elements depend on. Moving
 * a shape moves its label and re-routes every arrow fastened to it, so the two
 * kinds of patch take different paths through `applyEdit`.
 */
export function patchNeedsRebuild(patch: Record<string, unknown>): boolean {
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) continue
    if (GEOMETRY_KEYS.has(key)) return true
  }
  return false
}

/**
 * The roundness a shape of this kind gets.
 *
 * The editor's own default for a new shape is rounded, so `rounded` is read as
 * true unless the caller said otherwise — a board of square-cornered boxes is
 * not what an agent asking for "a box" means. Which algorithm depends on the
 * shape: rectangles take a fixed pixel radius, diamonds and linear elements a
 * proportional one, and an ellipse is already round.
 */
export function canvasRoundness(type: string, rounded: boolean | undefined): { type: number } | null {
  if (rounded === false) return null
  if (type === 'rectangle') return { type: ROUNDNESS_ADAPTIVE }
  if (type === 'diamond' || type === 'line' || type === 'arrow') return { type: ROUNDNESS_PROPORTIONAL }
  return null
}

/**
 * The padding the board's own lint assumes around a label. Wider than the
 * editor's, and deliberately so — see `labelFitBox`.
 */
const LINT_LABEL_PADDING = 16

/**
 * The smallest box a label of this text fits in.
 *
 * Two measures have to be satisfied at once, and neither one implies the other.
 *
 * The first is the board's own lint (`text_overflow` in
 * src/shared/canvas/lint.ts), which estimates a label at 0.6em per character
 * plus 16px and compares that to the shape's width. The worker can measure the
 * real glyphs and the lint cannot, so a shape sized to the true metrics would
 * still be reported as overflowing by the rule the agent is judged against —
 * and the agent would redraw a shape that was already fine.
 *
 * The second is where the label is actually drawn: inside the largest rectangle
 * that fits in the shape, which for a diamond is half its width and for an
 * ellipse is its width over root two, with the editor's own padding inside that.
 *
 * The bigger of the two wins. The editor grows the shape further still if the
 * measured glyphs need more room than either estimate allowed.
 */
export function labelFitBox(text: string, fontSize: number, containerType: string): { width: number; height: number } {
  const lines = text.split('\n')
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const textWidth = longest * fontSize * CHAR_WIDTH_RATIO
  const textHeight = lines.length * fontSize * LINE_HEIGHT_RATIO
  const inscribed = containerType === 'diamond' ? 2 : containerType === 'ellipse' ? Math.SQRT2 : 1
  const padded = 2 * CANVAS_BOUND_TEXT_PADDING
  return {
    // The extra pixel keeps the comparison off the boundary: the lint fires on
    // strictly greater, and two floating-point paths to the same number do not
    // always land on it.
    width: Math.ceil(Math.max(textWidth + LINT_LABEL_PADDING, (textWidth + padded) * inscribed)) + 1,
    height: Math.ceil(Math.max(textHeight + padded, (textHeight + padded) * inscribed)) + 1,
  }
}

/** Fields carried from the element a rebuild replaces, so it stays itself. */
export type SkeletonCarry = {
  seed?: number
  version?: number
  versionNonce?: number
  index?: string | null
  angle?: number
  link?: string | null
  groupIds?: string[]
  frameId?: string | null
  boundElements?: CanvasBoundElementRef[] | null
}

export type LibrarySkeletonInput = {
  /** The element's final id: minted for a create, its own for a rebuild. */
  id: string
  /** The agent-facing fields, already merged with whatever the element carried. */
  skeleton: CanvasSkeleton
  /** What to keep from the element being replaced. Absent on a create. */
  carry?: SkeletonCarry
  /** Reuse this id for the bound label rather than minting a new one. */
  labelId?: string | null
  /** Carried onto the label, so re-measuring it does not reset its history. */
  labelCarry?: SkeletonCarry
  /** A linear element's resolved absolute geometry. */
  linear?: { x: number; y: number; points: CanvasPoint[] } | null
  /** Binding targets, already resolved from tempIds to real ids. */
  startId?: string | null
  endId?: string | null
  /** A frame's children, already resolved to real ids. */
  children?: string[]
}

/** Style fields that translate one-for-one, when the skeleton sets them. */
const DIRECT_STYLE_KEYS = [
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeStyle',
  'strokeWidth',
  'roughness',
  'opacity',
] as const

export function toLibrarySkeleton(input: LibrarySkeletonInput): LibrarySkeleton {
  const { skeleton, carry } = input
  const type = skeleton.type
  const out: LibrarySkeleton = { type, id: input.id }

  out.x = finite(skeleton.x)
  out.y = finite(skeleton.y)

  for (const key of DIRECT_STYLE_KEYS) {
    const value = skeleton[key]
    if (value !== undefined) out[key] = value
  }
  if (skeleton.locked !== undefined) out.locked = skeleton.locked

  // Carried identity. `version` is passed through because the converter's
  // element constructor reads it (`version: rest.version || 1`); the caller
  // stamps the real bump afterwards, but starting from the old number means a
  // pass-through element comes back on the version it went in on.
  if (carry) {
    if (carry.seed !== undefined) out.seed = carry.seed
    if (carry.version !== undefined) out.version = carry.version
    if (carry.versionNonce !== undefined) out.versionNonce = carry.versionNonce
    if (carry.index !== undefined) out.index = carry.index
    if (carry.angle !== undefined) out.angle = carry.angle
    if (carry.link !== undefined) out.link = carry.link
    if (carry.frameId !== undefined) out.frameId = carry.frameId
  }

  const groupIds = skeleton.groupId ? [skeleton.groupId] : carry?.groupIds
  if (groupIds && groupIds.length > 0) out.groupIds = [...groupIds]

  const roundness = canvasRoundness(type, skeleton.rounded)
  if (roundness) out.roundness = roundness
  else out.roundness = null

  if (type === 'text') {
    applyTextElement(out, skeleton)
    return out
  }

  if (type === 'frame') {
    out.children = input.children ?? []
    if (typeof skeleton.name === 'string' && skeleton.name) out.name = skeleton.name
    // Always a box, even when the caller gave none: the converter sizes a frame
    // from its children with `||`, and an empty frame has no children to
    // measure, which leaves the arithmetic at infinity.
    out.width = positive(skeleton.width) ?? CANVAS_DEFAULT_FRAME_WIDTH
    out.height = positive(skeleton.height) ?? CANVAS_DEFAULT_FRAME_HEIGHT
    // A frame has no roughness or fill of its own; the editor draws its chrome.
    delete out.roundness
    return out
  }

  if (type === 'arrow' || type === 'line') {
    applyLinear(out, input)
    return out
  }

  applyContainer(out, input)
  return out
}

function applyContainer(out: LibrarySkeleton, input: LibrarySkeletonInput): void {
  const { skeleton, carry } = input
  const label = typeof skeleton.text === 'string' ? skeleton.text : ''
  const fontSize = positive(skeleton.fontSize) ?? CANVAS_DEFAULT_FONT_SIZE

  let width = positive(skeleton.width) ?? (label ? 0 : undefined)
  let height = positive(skeleton.height) ?? (label ? 0 : undefined)
  if (label) {
    const fit = labelFitBox(label, fontSize, skeleton.type)
    width = Math.max(width ?? 0, fit.width)
    height = Math.max(height ?? 0, fit.height)
  }
  if (width !== undefined) out.width = width
  if (height !== undefined) out.height = height

  // Text refs are dropped and re-added by the converter, which concatenates
  // rather than replaces — left in place they would be listed twice.
  out.boundElements = withoutTextRefs(carry?.boundElements)

  if (label) {
    out.label = buildLabel(input, label, fontSize)
  }
}

function applyLinear(out: LibrarySkeleton, input: LibrarySkeletonInput): void {
  const { skeleton } = input
  const geometry = input.linear
  if (geometry) {
    out.x = geometry.x
    out.y = geometry.y
    out.points = geometry.points.map((point) => [point[0], point[1]])
    const last = geometry.points[geometry.points.length - 1] ?? [0, 0]
    out.width = Math.abs(last[0])
    out.height = Math.abs(last[1])
  } else {
    applyBox(out, skeleton)
  }

  if (skeleton.type === 'arrow') {
    // The converter defaults an arrow's head on, so only an explicit null has
    // to be passed; a caller naming a head by name is passed through as given.
    if (skeleton.endArrowhead !== undefined) out.endArrowhead = skeleton.endArrowhead
    if (skeleton.startArrowhead !== undefined) out.startArrowhead = skeleton.startArrowhead
    if (skeleton.elbowed === true) out.elbowed = true
    if (input.startId) out.start = { id: input.startId }
    if (input.endId) out.end = { id: input.endId }
  }

  out.boundElements = withoutTextRefs(input.carry?.boundElements)

  const label = typeof skeleton.text === 'string' ? skeleton.text : ''
  if (label && skeleton.type === 'arrow') {
    out.label = buildLabel(input, label, positive(skeleton.fontSize) ?? CANVAS_DEFAULT_FONT_SIZE)
  }
}

function applyTextElement(out: LibrarySkeleton, skeleton: CanvasSkeleton): void {
  out.text = typeof skeleton.text === 'string' ? skeleton.text : ''
  out.fontSize = positive(skeleton.fontSize) ?? CANVAS_DEFAULT_FONT_SIZE
  out.fontFamily = CANVAS_FONT_FAMILY_ID[skeleton.fontFamily ?? 'hand']
  out.textAlign = skeleton.textAlign ?? 'left'
  out.verticalAlign = 'top'
  // A standalone text element sizes itself to its content; a width the caller
  // passed would only fight the measurement.
  out.autoResize = true
  out.containerId = null
  delete out.roundness
}

function buildLabel(input: LibrarySkeletonInput, text: string, fontSize: number): LibrarySkeleton {
  const { skeleton } = input
  const label: LibrarySkeleton = {
    text,
    fontSize,
    fontFamily: CANVAS_FONT_FAMILY_ID[skeleton.fontFamily ?? 'hand'],
    textAlign: skeleton.textAlign ?? 'center',
    verticalAlign: 'middle',
  }
  if (input.labelId) label.id = input.labelId
  const carry = input.labelCarry
  if (carry) {
    if (carry.seed !== undefined) label.seed = carry.seed
    if (carry.version !== undefined) label.version = carry.version
    if (carry.versionNonce !== undefined) label.versionNonce = carry.versionNonce
    if (carry.index !== undefined) label.index = carry.index
  }
  if (typeof skeleton.strokeColor === 'string') label.strokeColor = skeleton.strokeColor
  return label
}

function applyBox(out: LibrarySkeleton, skeleton: CanvasSkeleton): void {
  const width = positive(skeleton.width)
  const height = positive(skeleton.height)
  if (width !== undefined) out.width = width
  if (height !== undefined) out.height = height
}

function withoutTextRefs(refs: CanvasBoundElementRef[] | null | undefined): CanvasBoundElementRef[] {
  if (!Array.isArray(refs)) return []
  return refs.filter((ref) => ref && ref.type !== 'text')
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** The fields a rebuild carries over from the element it replaces. */
export function carryFrom(element: CanvasElement): SkeletonCarry {
  return {
    seed: typeof element.seed === 'number' ? element.seed : undefined,
    version: typeof element.version === 'number' ? element.version : undefined,
    versionNonce: typeof element.versionNonce === 'number' ? element.versionNonce : undefined,
    index: element.index ?? null,
    angle: typeof element.angle === 'number' ? element.angle : undefined,
    link: typeof element.link === 'string' ? element.link : null,
    groupIds: Array.isArray(element.groupIds)
      ? (element.groupIds.filter((id) => typeof id === 'string') as string[])
      : [],
    frameId: typeof element.frameId === 'string' ? element.frameId : null,
    boundElements: Array.isArray(element.boundElements) ? element.boundElements : null,
  }
}

/** The skeleton types the agent format and the converter both understand. */
export const CANVAS_CONTAINER_TYPES: ReadonlySet<CanvasSkeletonType> = new Set(['rectangle', 'ellipse', 'diamond'])
