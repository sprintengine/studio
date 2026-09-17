// The Canvas pane's vocabulary: the scene on disk, the agent-facing skeleton,
// and the result envelope every canvas call answers in. Node-free and DOM-free
// on purpose — main, preload, the renderer tab and the hidden worker window all
// import from here, and src/shared may reach into none of them (TS6307).
//
// Nothing here imports the editor package. A scene is modelled structurally, so
// the editor can add a field in a minor release and it still round-trips.

/** A workspace-relative board: the pair every canvas call is addressed by. */
export type CanvasBoardRef = {
  workspaceId: string
  /** Posix, project-relative, `*.excalidraw`. See `normalizeCanvasPath`. */
  path: string
}

/** One board as the picker and `canvas.list` show it. */
export type CanvasBoardSummary = {
  path: string
  /** Basename without the extension — what the tab and the picker label. */
  name: string
  elementCount: number
  /** File mtime, epoch milliseconds. */
  modifiedAt: number
}

/** A board's live scene, as handed to a subscriber on open and on every push. */
export type CanvasBoardState = {
  path: string
  /** Bumped by the service on every accepted write; the merge base a commit cites. */
  revision: number
  elements: CanvasElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

/** An element another element is bound to: a label, or an arrow at one end. */
export type CanvasBoundElementRef = { id: string; type: 'arrow' | 'text' }

/** An arrow end fastened to a shape. `focus`/`gap` are the editor's own. */
export type CanvasBinding = {
  elementId: string
  focus: number
  gap: number
  /** Elbow arrows only: the fixed point on the bound shape, in its local space. */
  fixedPoint?: [number, number] | null
}

/** A point on a linear element, relative to that element's `x`/`y`. */
export type CanvasPoint = [number, number]

/**
 * One scene element.
 *
 * Structural and permissive by design: the four fields the merge needs are
 * required, the fields our own logic reads are declared optional, and the index
 * signature carries everything else — a field we have never heard of survives
 * parse → merge → serialize byte for byte. Widening this type is cheap;
 * dropping a field on the floor corrupts the person's drawing.
 */
export type CanvasElement = {
  id: string
  type: string
  /** Monotonic per element. The merge's first tie-break. */
  version: number
  /** Random per edit. The merge's second tie-break, lower wins. */
  versionNonce: number
  /** A tombstone: the id stays in the scene so the deletion can be merged. */
  isDeleted?: boolean
  /** Epoch milliseconds of the last edit; what tombstone expiry reads. */
  updated?: number

  x?: number
  y?: number
  width?: number
  height?: number
  angle?: number

  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeWidth?: number
  strokeStyle?: string
  roughness?: number
  opacity?: number
  groupIds?: string[]
  frameId?: string | null
  /** Fractional index: a sortable string that fixes paint order. */
  index?: string | null
  roundness?: { type: number; value?: number } | null
  seed?: number
  boundElements?: CanvasBoundElementRef[] | null
  link?: string | null
  locked?: boolean

  // Text elements, and the labels bound into a shape or an arrow.
  text?: string
  originalText?: string
  fontSize?: number
  /** The editor's numeric family id; `toSkeleton` maps it to a name. */
  fontFamily?: number
  textAlign?: string
  verticalAlign?: string
  /** Set on a bound label; points at the shape or arrow that carries it. */
  containerId?: string | null
  autoResize?: boolean
  lineHeight?: number

  // Linear elements (arrows and lines).
  points?: CanvasPoint[]
  startBinding?: CanvasBinding | null
  endBinding?: CanvasBinding | null
  startArrowhead?: string | null
  endArrowhead?: string | null
  elbowed?: boolean

  /** Frames only: the name drawn above the frame. */
  name?: string | null

  [key: string]: unknown
}

/** A `.excalidraw` document: what is written to and read from the project. */
export type CanvasSceneFile = {
  type: 'excalidraw'
  version: number
  source: string
  elements: CanvasElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

/** The element kinds an agent can author. See `toSkeleton` for the rest. */
export type CanvasSkeletonType =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'text'
  | 'arrow'
  | 'line'
  | 'frame'

/**
 * The agent-facing element: what `canvas.find` returns and `canvas.edit` takes.
 *
 * It names shapes an arrow connects instead of carrying bindings, and folds a
 * shape's bound label into `text`, because an agent that authors raw bindings
 * gets them subtly wrong and the drawing falls apart on the first drag.
 */
export type CanvasSkeleton = {
  /** An existing element's id. Absent on a create. */
  id?: string
  /** A handle for a new element, referenced by other creates in the same request. */
  tempId?: string
  type: CanvasSkeletonType
  x: number
  y: number
  width?: number
  height?: number
  /** Label for a shape or an arrow; the content of a text element. */
  text?: string
  /** Arrows and lines: the element each end fastens to, by id or tempId. */
  startElementId?: string
  endElementId?: string
  /** Absolute points, emitted only for a multi-point or unbound linear element. */
  points?: Array<[number, number]>
  elbowed?: boolean
  startArrowhead?: string | null
  endArrowhead?: string | null
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  strokeWidth?: number
  roughness?: number
  opacity?: number
  fontSize?: number
  fontFamily?: 'hand' | 'normal' | 'code'
  textAlign?: 'left' | 'center' | 'right'
  rounded?: boolean
  locked?: boolean
  /** Frames: the elements the frame holds, and its title. */
  children?: string[]
  name?: string
  groupId?: string
}

/** The fields an update may set: everything but the element's identity and kind. */
export type CanvasSkeletonPatch = Partial<Omit<CanvasSkeleton, 'id' | 'tempId' | 'type'>>

/** One edit, applied in the order delete → update → create. */
export type CanvasEditRequest = {
  delete?: string[]
  update?: Array<{ id: string; set: CanvasSkeletonPatch }>
  create?: CanvasSkeleton[]
}

/** What an accepted edit did, in the words a tool answers with. */
export type CanvasEditResult = {
  /** Ids of the created elements, in request order. */
  created: string[]
  updated: string[]
  deleted: string[]
  /** `tempId` → the id the element was given. */
  tempIds: Record<string, string>
  /** Non-fatal notes: a repaired binding, a clamped value. */
  warnings: string[]
  /** The scene's lint after the edit, when the caller asked for it. */
  lint?: CanvasLintReport
}

/** One arrange operation over a selection. `to`/`direction`/`gap` are per-op. */
export type CanvasLayoutRequest = {
  op: 'align' | 'distribute' | 'stack' | 'group' | 'ungroup' | 'lock' | 'unlock'
  elementIds: string[]
  to?: 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y'
  direction?: 'horizontal' | 'vertical'
  gap?: number
}

/** Bring a diagram in from text or from another scene file. */
export type CanvasImportRequest = {
  mermaid?: string
  scene?: unknown
  mode: 'merge' | 'replace'
}

/** A rendered board. `data` is base64, sized to stay under the gateway's line limit. */
export type CanvasImage = {
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

export type CanvasLintIssueType =
  | 'overlap'
  | 'cramped'
  | 'text_overflow'
  | 'dangling_binding'
  | 'one_way_binding'
  | 'short_arrow'
  | 'arrow_tip_inside_shape'
  | 'fan_in_same_focus'
  | 'duplicate_id'

export type CanvasLintSeverity = 'high' | 'medium' | 'low'

export type CanvasLintIssue = {
  type: CanvasLintIssueType
  severity: CanvasLintSeverity
  elementIds: string[]
  /** One sentence naming what is wrong, in terms the agent can act on. */
  detail: string
}

export type CanvasLintReport = {
  /** 100 minus the weight of every issue found, floored at 0. */
  score: number
  issues: CanvasLintIssue[]
  /** Issues beyond the report cap. The score already counts the listed ones. */
  omitted: number
  /**
   * The scan stopped before it had seen everything, so `omitted` is a floor and
   * the score is an upper bound. A board big enough for this is a board the
   * lint cannot judge whole; `notes` says which rules gave up.
   */
  truncated?: boolean
  /** What was not checked, in words an agent can act on. */
  notes?: string[]
}

/** Who holds the pen right now, mirrored to every subscriber. */
export type CanvasPresence = {
  controller: 'human' | 'agent' | 'none'
  agentName?: string
  pointer?: { x: number; y: number }
  selectedElementIds?: string[]
}

/** One entry in a board's action log, as `canvas.describe` reports it. */
export type CanvasActionEntry = {
  id: string
  /** The tool or gesture that ran: `canvas.edit`, `canvas.layout`, … */
  action: string
  summary: string
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  actor: 'agent' | 'human'
  agentName?: string
  /** Epoch milliseconds. */
  startedAt: number
  completedAt?: number
  error?: string
}

/** A scene pushed to subscribers after an accepted write. */
export type CanvasScenePush = CanvasBoardRef & {
  revision: number
  elements: CanvasElement[]
  files: Record<string, unknown>
  /** What caused the write, so a subscriber can ignore its own echo. */
  origin: 'agent' | 'human' | 'disk'
}

/**
 * Every way a canvas call can fail. The set is closed so a tool can answer the
 * same words for the same cause whichever layer raised it.
 */
export type CanvasErrorCode =
  | 'no_workspace'
  | 'unknown_workspace'
  | 'forbidden'
  | 'invalid_path'
  | 'not_found'
  | 'invalid_scene'
  | 'invalid_edit'
  | 'unknown_element'
  | 'interrupted'
  | 'worker_unavailable'
  | 'timeout'
  | 'too_large'

export type CanvasError = {
  code: CanvasErrorCode
  message: string
}

/** The envelope every canvas call answers in: no canvas path throws at a boundary. */
export type CanvasResult<T> = { ok: true; value: T } | { ok: false; error: CanvasError }

export function canvasOk<T>(value: T): CanvasResult<T> {
  return { ok: true, value }
}

export function canvasFail<T = never>(code: CanvasErrorCode, message: string): CanvasResult<T> {
  return { ok: false, error: { code, message } }
}

export function canvasError(code: CanvasErrorCode, message: string): CanvasError {
  return { code, message }
}
