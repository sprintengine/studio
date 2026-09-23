import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { isRecord } from '../../shared/records'
import { describeScene, type CanvasDescribeDetail } from '../../shared/canvas/describe'
import { findElements, type CanvasFindQuery } from '../../shared/canvas/find'
import { lintScene } from '../../shared/canvas/lint'
import {
  CANVAS_LIST_MAX_BOARDS,
  DEFAULT_CANVAS_BOARD_PATH,
  canvasBoardName,
  canvasLegacyPathFor,
  normalizeCanvasPath,
} from '../../shared/canvas/paths'
import { CANVAS_SKELETON_TYPES, toSkeleton } from '../../shared/canvas/skeleton'
import type {
  CanvasBoardRef,
  CanvasBoardState,
  CanvasEditRequest,
  CanvasError,
  CanvasLayoutRequest,
  CanvasLintReport,
} from '../../shared/canvas/types'
import { canvasReaderKey } from '../canvas/canvas-service-types'
import type { CanvasActor, CanvasService } from '../canvas/canvas-service-types'

// The `canvas.*` gateway tools (canvas-pane epic, package F): an agent's hands
// on the SAME board the person draws on — a `.excalidraw` file in the app's
// board store, kept per project in the app's data folder (or, for a board made
// before boards moved there, in the project's own tree), merged per element,
// with the person always winning a contested shape.
//
// Boards are named, never located: an agent passes a bare name or a
// project-relative path, and main resolves it. So an agent whose shell sees a
// different filesystem from main's (a WSL session on a Windows host) needs no
// path translation, and no tool ever answers with a store path it would have
// to translate.
//
// Every tool takes an optional `board`; omitted, it targets the workspace's most
// recently changed board and falls back to the default path. The workspace is
// the connection's own, as stamped by the gateway, or an explicit `workspaceId`
// for connections without one — the browser family's rule, unchanged.

export const CANVAS_MUTATION_TOOL_NAMES: readonly string[] = [
  'canvas.open',
  'canvas.edit',
  'canvas.layout',
  'canvas.import',
]

/** Enough matches to work with; more than this and the agent wants a narrower filter. */
const MAX_FIND_RESULTS = 200

/**
 * A tool result is one socket line (1 MiB) and is serialised twice — once
 * pretty-printed as the text block, once as `structuredContent` — so every list
 * here is bounded well inside that. The skeleton is the only part that grows
 * with the board: 150 KB of compact JSON is roughly 400 KB pretty-printed plus
 * the 150 KB copy, which leaves the describe text and the action log room to sit
 * beside it.
 */
const MAX_SKELETON_JSON_BYTES = 150_000
const DESCRIBE_LINT_ISSUES = 10
const EDIT_LINT_ISSUES = 20
const DESCRIBE_ACTIONS = 10

export type CanvasToolsDeps = {
  service: CanvasService
  /** Whether a workspace id names an open workspace. */
  hasWorkspace: (workspaceId: string) => boolean
  /** Live enablement of the Canvas module; read per call, never captured. */
  isCanvasEnabled: () => boolean
}

function success(structured: Record<string, unknown>, image?: { data: string; mimeType: string }): McpToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(structured, null, 2) },
      ...(image ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : []),
    ],
    structuredContent: structured,
  }
}

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

/** Every canvas failure answers in the same words wherever it was raised. */
function canvasFailure(error: CanvasError): McpToolResult {
  return failure(error.code, error.message)
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boolOrNull(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key]
  return typeof value === 'boolean' ? value : null
}

function idList(args: Record<string, unknown>, key: string): string[] | null {
  const value = args[key]
  if (!Array.isArray(value)) return null
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/**
 * The matches that fit in one answer.
 *
 * A count budget alone is not a size budget: two hundred frames with long names
 * and multi-line labels is a bigger payload than the describe tool's whole
 * ceiling, and a result that does not fit one line of the gateway's protocol is
 * a result nobody receives. So the skeletons are taken one at a time until the
 * same byte budget `canvas.describe` uses is reached.
 */
function boundedMatches(matches: ReturnType<typeof findElements>): {
  elements: ReturnType<typeof findElements>
  omitted: number
  budgeted: boolean
} {
  const capped = matches.slice(0, MAX_FIND_RESULTS)
  const elements: typeof capped = []
  let bytes = 2
  for (const skeleton of capped) {
    // One element plus its separator, measured as it will be serialised.
    const size = jsonBytes(skeleton) + 1
    if (elements.length > 0 && bytes + size > MAX_SKELETON_JSON_BYTES) break
    bytes += size
    elements.push(skeleton)
  }
  return {
    elements,
    omitted: matches.length - elements.length,
    budgeted: elements.length < capped.length,
  }
}

/** The lint an agent is shown: the same score, the worst issues, and the count it did not see. */
function boundedLint(report: CanvasLintReport, max: number): CanvasLintReport {
  if (report.issues.length <= max) return report
  return {
    ...report,
    issues: report.issues.slice(0, max),
    omitted: report.omitted + (report.issues.length - max),
  }
}

function lintLines(report: CanvasLintReport): string[] {
  const total = report.issues.length + report.omitted
  // A truncated scan counted what it saw and stopped; saying "at least" is the
  // difference between a board that is nearly clean and one nobody finished
  // reading.
  const lines = [`Lint: ${report.score}/100, ${report.truncated ? 'at least ' : ''}${total} issue(s).`]
  for (const issue of report.issues) lines.push(`- ${issue.severity} ${issue.type}: ${issue.detail}`)
  if (report.omitted > 0) lines.push(`- ... and ${report.truncated ? 'at least ' : ''}${report.omitted} more issue(s).`)
  for (const note of report.notes ?? []) lines.push(`- ${note}`)
  return lines
}

const SHARED_PROPERTIES = {
  board: {
    type: 'string',
    description:
      'The board to act on. Normally a bare name such as "architecture" (or "architecture.excalidraw"): it names a board in the app\'s own board store, which the app keeps for this project outside the project folder, or, when the store has none of that name, an older board already in the project\'s diagrams/ folder. A path with a folder, such as "docs/architecture.excalidraw", names that file in the project exactly. Omitted, the workspace\'s most recently changed board, or the store board "canvas" when it has none. Always name a board this way, never by a filesystem path.',
  },
  workspaceId: { type: 'string', description: 'Only for connections not bound to a workspace.' },
} as const

const POINT_SCHEMA = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: { type: 'number', description: 'A coordinate in scene pixels.' },
  description: 'One [x, y] point in scene pixels.',
} as const

// Hand-written and complete: this schema is the only documentation an agent has
// for the skeleton format, and every wrong guess it makes here (an unattached
// arrow, a label on a zone, a box too small for its own text) shows up as a
// broken drawing rather than as an error.
const SKELETON_PROPERTIES = {
  tempId: {
    type: 'string',
    description:
      'A handle for this new element, e.g. "api". Other creates in the SAME request point at it with startElementId/endElementId, and the result maps it to the id the element was given.',
  },
  type: {
    type: 'string',
    enum: [...CANVAS_SKELETON_TYPES],
    description:
      'The kind of element: rectangle, ellipse or diamond for a node, text for free text, arrow or line for a connector, frame to enclose a section.',
  },
  x: {
    type: 'number',
    description:
      'Left edge in scene pixels. The origin is top-left and y grows DOWNWARD, so a lower row has a larger y.',
  },
  y: { type: 'number', description: 'Top edge in scene pixels, growing downward.' },
  width: {
    type: 'number',
    description:
      'Width in scene pixels. A labelled shape needs room for its text: roughly 10 px per character at the default font size plus padding, and at least 120. Omit on text elements, which size themselves.',
  },
  height: {
    type: 'number',
    description:
      'Height in scene pixels. At least 60 for a labelled shape, more for two lines of label. Omit on text elements.',
  },
  text: {
    type: 'string',
    description:
      'On a shape or an arrow, a label drawn CENTRED on it — keep it to a few words. On a text element, the content itself. A title for a region belongs on its own text element above the region, not as the label of a large rectangle, where it would sit on top of everything inside.',
  },
  startElementId: {
    type: 'string',
    description:
      'Arrows and lines: the element the tail attaches to, named by an existing id or by a tempId from this same request. This is the ONLY way to attach an arrow — geometry that merely touches a shape is not attached, and the arrow comes loose as soon as anything moves.',
  },
  endElementId: {
    type: 'string',
    description: 'Arrows and lines: the element the head attaches to, by existing id or by a tempId from this request.',
  },
  points: {
    type: 'array',
    items: POINT_SCHEMA,
    description:
      'Absolute [x, y] points for a multi-segment connector or one that deliberately attaches to nothing. Leave it out for an ordinary arrow between two shapes: the ends are computed from the bindings and stay correct when the shapes move.',
  },
  elbowed: {
    type: 'boolean',
    description: 'Arrows: route in right angles instead of a straight line. Reads well in a dense orthogonal diagram.',
  },
  startArrowhead: {
    type: ['string', 'null'],
    description:
      'Arrowhead at the tail: "arrow", "triangle", "dot", "bar", or null for none. Null is the usual choice.',
  },
  endArrowhead: {
    type: ['string', 'null'],
    description: 'Arrowhead at the head: "arrow" (the default), "triangle", "dot", "bar", or null for a plain line.',
  },
  strokeColor: { type: 'string', description: 'Outline and text colour as a hex string, e.g. "#1e1e1e".' },
  backgroundColor: {
    type: 'string',
    description: 'Fill colour as a hex string, or "transparent". Pale fills paired with a darker stroke read best.',
  },
  fillStyle: {
    type: 'string',
    enum: ['solid', 'hachure', 'cross-hatch'],
    description: 'How the fill is drawn. "solid" for a flat colour; the others are sketched hatching.',
  },
  strokeStyle: {
    type: 'string',
    enum: ['solid', 'dashed', 'dotted'],
    description: 'Line style. Use dashed for something optional, asynchronous or planned, and keep solid as the norm.',
  },
  strokeWidth: { type: 'number', description: 'Line thickness in pixels; 1 thin, 2 the default, 4 bold.' },
  roughness: { type: 'number', description: 'How hand-drawn the strokes look: 0 precise, 1 the default, 2 sketchy.' },
  opacity: { type: 'number', description: 'Opacity from 0 to 100; 100 is the default.' },
  fontSize: { type: 'number', description: 'Text size in pixels: 16 small, 20 the default, 28 large, 36 for a title.' },
  fontFamily: {
    type: 'string',
    enum: ['hand', 'normal', 'code'],
    description: 'The voice of the text: "hand" (the board default), "normal" for a plain face, "code" for monospace.',
  },
  textAlign: {
    type: 'string',
    enum: ['left', 'center', 'right'],
    description: 'Horizontal alignment of the text. A label on a shape is centred; free text is usually left aligned.',
  },
  rounded: { type: 'boolean', description: 'Rounded corners on a rectangle or diamond.' },
  locked: { type: 'boolean', description: 'Lock the element so a stray drag cannot move it. Use sparingly.' },
  children: {
    type: 'array',
    items: { type: 'string', description: 'The id, or a tempId from this request, of an element the frame holds.' },
    description: 'Frames only: the elements this frame encloses.',
  },
  name: { type: 'string', description: 'Frames only: the title drawn above the frame.' },
  groupId: {
    type: 'string',
    description: 'Put this element in a group with every other element of this request carrying the same groupId.',
  },
} as const

const CREATE_SCHEMA = {
  type: 'object',
  properties: SKELETON_PROPERTIES,
  required: ['type', 'x', 'y'],
  additionalProperties: false,
  description: 'One element to create.',
} as const

// An update may set any field but the two that fix an element's identity and
// kind; `id` is not a skeleton field on a create, so it never appears here.
const PATCH_PROPERTIES: Record<string, unknown> = Object.fromEntries(
  Object.entries(SKELETON_PROPERTIES).filter(([key]) => key !== 'tempId' && key !== 'type'),
)

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The id of the element to change, from canvas.describe or canvas.find.' },
    set: {
      type: 'object',
      properties: PATCH_PROPERTIES,
      additionalProperties: false,
      description: "The fields to change. An element's id and kind are fixed for its life and cannot be set here.",
    },
  },
  required: ['id', 'set'],
  additionalProperties: false,
  description: 'One element to change.',
} as const

const BBOX_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'Left edge of the rectangle in scene pixels.' },
    y: { type: 'number', description: 'Top edge of the rectangle in scene pixels.' },
    width: { type: 'number', description: 'Width of the rectangle in scene pixels.' },
    height: { type: 'number', description: 'Height of the rectangle in scene pixels.' },
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
  description: 'A rectangle in scene coordinates. Anything that touches it matches; it need not be contained.',
} as const

export function createCanvasTools(deps: CanvasToolsDeps): McpToolRegistration[] {
  const { service } = deps

  function resolveWorkspace(args: Record<string, unknown>, context?: McpConnectionContext): string | McpToolResult {
    const bound = context?.metadata.workspaceId
    const explicit = str(args, 'workspaceId')
    if (bound && explicit && explicit !== bound) {
      return failure('forbidden', 'This connection is bound to its own workspace; drop `workspaceId`.')
    }
    const workspaceId = bound ?? explicit
    if (!workspaceId) return failure('no_workspace', 'This connection is not bound to a workspace; pass `workspaceId`.')
    if (!deps.hasWorkspace(workspaceId)) {
      return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    }
    return workspaceId
  }

  function actorOf(workspaceId: string, context?: McpConnectionContext): CanvasActor {
    return {
      kind: 'agent',
      workspaceId,
      ...(context?.metadata.agentId ? { agentId: context.metadata.agentId } : {}),
      ...(context?.metadata.agentName ? { agentName: context.metadata.agentName } : {}),
    }
  }

  /**
   * Which board the call is about.
   *
   * A named board is normalized and refused here rather than at the fs call. An
   * unnamed one is the workspace's most recently changed board, because an agent
   * that just drew something and came back is talking about that board; a
   * workspace with no boards at all gets the default path, which the mutating
   * tools then create.
   */
  async function resolveBoard(
    args: Record<string, unknown>,
    context?: McpConnectionContext,
  ): Promise<{ workspaceId: string; ref: CanvasBoardRef } | McpToolResult> {
    const workspaceId = resolveWorkspace(args, context)
    if (typeof workspaceId !== 'string') return workspaceId
    const named = str(args, 'board')
    if (named) {
      const normalized = normalizeCanvasPath(named)
      if (!normalized.ok) return canvasFailure(normalized.error)
      const ref = { workspaceId, path: normalized.value }
      // A bare name lands in the app's store, unless the store has no board of
      // that name and the project's legacy folder does: an agent asked about
      // "architecture" means the board the person already has, not a fresh
      // empty one beside it.
      const legacy = canvasLegacyPathFor(named)
      if (legacy) {
        const inStore = await service.boardExists(ref)
        if (!inStore.ok) return canvasFailure(inStore.error)
        if (!inStore.value) {
          const legacyRef = { workspaceId, path: legacy }
          const inProject = await service.boardExists(legacyRef)
          if (inProject.ok && inProject.value) return { workspaceId, ref: legacyRef }
        }
      }
      return { workspaceId, ref }
    }
    const listed = await service.listBoards(workspaceId)
    if (!listed.ok) return canvasFailure(listed.error)
    const newest = newestFirst(listed.value)[0]
    return { workspaceId, ref: { workspaceId, path: newest?.path ?? DEFAULT_CANVAS_BOARD_PATH } }
  }

  /** The board as a read tool sees it: missing is an answer, not a crash. */
  async function readBoard(ref: CanvasBoardRef): Promise<CanvasBoardState | McpToolResult> {
    const read = await service.readBoard(ref)
    if (read.ok) return read.value
    if (read.error.code === 'not_found') {
      return failure(
        'not_found',
        `There is no board at ${ref.path} yet. canvas.open creates it and shows it to the person, or canvas.edit creates it with your first shapes.`,
      )
    }
    return canvasFailure(read.error)
  }

  /** The board as a mutating tool needs it: created on demand. */
  async function ensureBoard(ref: CanvasBoardRef): Promise<CanvasBoardState | McpToolResult> {
    const read = await service.readBoard(ref, { create: true })
    return read.ok ? read.value : canvasFailure(read.error)
  }

  function boardInfo(ref: CanvasBoardRef, state: CanvasBoardState): Record<string, unknown> {
    return {
      path: state.path || ref.path,
      name: canvasBoardName(state.path || ref.path),
      revision: state.revision,
      elementCount: liveElements(state).length,
    }
  }

  const tools: McpToolRegistration[] = [
    {
      name: 'canvas.list',
      description:
        "List the Canvas boards in this workspace with their element count and when each last changed, most recently changed first. A board is an .excalidraw file. New boards live in the app's own board store, kept for this project outside the project folder, and are listed by bare file name (e.g. architecture.excalidraw); the person puts one into the repository with the Canvas tab's Export action. Boards an earlier version made in the project's diagrams/ folder are listed by their project path, and stay where they are. Capped at 200, with a note when the cap was reached. Read-only.",
      inputSchema: {
        type: 'object',
        properties: { workspaceId: SHARED_PROPERTIES.workspaceId },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const workspaceId = resolveWorkspace(args, context)
        if (typeof workspaceId !== 'string') return workspaceId
        const listed = await service.listBoards(workspaceId)
        if (!listed.ok) return canvasFailure(listed.error)
        const ordered = newestFirst(listed.value)
        const boards = ordered.map((board) => ({
          path: board.path,
          name: board.name,
          elementCount: board.elementCount,
          modifiedAt: new Date(board.modifiedAt).toISOString(),
        }))
        // The service returns the most recently changed boards and stops at the
        // cap, so a full page is the one case where the answer is not the whole
        // workspace — and saying "there may be more" is the only truthful thing
        // to say about it, since nothing counted what it did not list.
        const capped = boards.length >= CANVAS_LIST_MAX_BOARDS
        return success({
          boards,
          ...(capped
            ? {
                note: `These are the ${CANVAS_LIST_MAX_BOARDS} most recently changed boards in this workspace; there may be more. Name a board directly with \`board\` if you do not see it.`,
              }
            : {}),
        })
      },
    },
    {
      name: 'canvas.open',
      description:
        'Create the board if it does not exist and reveal its Canvas tab, docked, in the window showing this workspace — so the person can watch you draw. `revealed: false` is not a failure: it means no window is showing the workspace right now, and the board stays fully usable through the other canvas tools.',
      inputSchema: {
        type: 'object',
        properties: { board: SHARED_PROPERTIES.board, workspaceId: SHARED_PROPERTIES.workspaceId },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = await resolveBoard(args, context)
        if ('content' in resolved) return resolved
        const state = await ensureBoard(resolved.ref)
        if ('content' in state) return state
        const opened = await service.requestOpen(resolved.ref)
        if (!opened.ok) return canvasFailure(opened.error)
        return success({
          board: boardInfo(resolved.ref, state),
          revealed: opened.value.revealed,
          ...(opened.value.revealed
            ? {}
            : {
                note: 'No window is showing this workspace, so the tab could not be revealed. The board is on disk and every other canvas tool works on it.',
              }),
        })
      },
    },
    {
      name: 'canvas.describe',
      description:
        "The board in text: counts and bounds, one line per element with its id, position and label, and the connections between them — plus the lint score, what the person changed since you last looked, and the board's recent actions. Start every canvas task here; never assume a board is empty. `detail: full` also returns the editable skeleton of every element. Read-only.",
      inputSchema: {
        type: 'object',
        properties: {
          board: SHARED_PROPERTIES.board,
          detail: {
            type: 'string',
            enum: ['summary', 'outline', 'full'],
            description:
              'How much to read: "summary" counts and bounds only, "outline" (the default) one line per element, "full" adds styles and the editable skeleton of every element.',
          },
          workspaceId: SHARED_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = await resolveBoard(args, context)
        if ('content' in resolved) return resolved
        const state = await readBoard(resolved.ref)
        if ('content' in state) return state

        const requested = str(args, 'detail')
        const detail: CanvasDescribeDetail =
          requested === 'summary' || requested === 'full' || requested === 'outline' ? requested : 'outline'

        // `full` carries the whole skeleton, which is the one part of this
        // result that grows with the board. Past the budget it is dropped for
        // the outline and a pointer at the tool that reads a board in pieces —
        // a truncated skeleton would be edited as if it were the whole board.
        let elements: ReturnType<typeof toSkeleton> | null = null
        let skeletonNote: string | null = null
        let rendered: CanvasDescribeDetail = detail
        if (detail === 'full') {
          const skeletons = toSkeleton(state.elements)
          if (jsonBytes(skeletons) > MAX_SKELETON_JSON_BYTES) {
            rendered = 'outline'
            skeletonNote =
              'This board is too large to return in full. Read it in pieces with canvas.find, narrowed by a `bbox` region or by `type`.'
          } else {
            elements = skeletons
          }
        }

        const lint = boundedLint(lintScene(state.elements), DESCRIBE_LINT_ISSUES)
        const changes = service.changesSinceLastRead(
          resolved.ref,
          canvasReaderKey(resolved.workspaceId, context?.metadata.agentId),
        )
        const actions = service.actions(resolved.ref).slice(-DESCRIBE_ACTIONS)

        const sections = [describeScene(state.elements, rendered), '', ...lintLines(lint)]
        if (changes.length > 0)
          sections.push('', 'Changed since you last looked:', ...changes.map((line) => `- ${line}`))
        if (actions.length > 0) {
          sections.push('', 'Recent actions')
          for (const entry of actions) {
            const who = entry.actor === 'human' ? 'the person' : (entry.agentName ?? 'an agent')
            sections.push(`- ${entry.action} by ${who}: ${entry.summary} (${entry.status})`)
          }
        }
        if (skeletonNote) sections.push('', skeletonNote)

        return success({
          board: boardInfo(resolved.ref, state),
          detail: rendered,
          description: sections.join('\n'),
          lint,
          changesSinceLastRead: changes,
          actions,
          ...(elements ? { elements } : {}),
          ...(skeletonNote ? { elementsOmitted: true } : {}),
        })
      },
    },
    {
      name: 'canvas.find',
      description:
        'Find elements by label text, kind, region or id and get their skeletons back — the same shape canvas.edit takes, ready to be passed to an update. Give at least one filter. Use it to read a large board in pieces. The answer is capped by count AND by size; `omitted` and its note say when a narrower filter is needed. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          board: SHARED_PROPERTIES.board,
          query: {
            type: 'string',
            description:
              'Substring of a label, a frame name or an id. Case and separators are ignored, so "auth flow" finds "Auth Flow" and "auth-flow".',
          },
          type: {
            type: 'string',
            enum: [...CANVAS_SKELETON_TYPES],
            description: 'Keep only elements of this kind. Freehand strokes, images and embeds are never returned.',
          },
          bbox: BBOX_SCHEMA,
          ids: {
            type: 'array',
            items: { type: 'string', description: 'An element id from canvas.describe or an earlier canvas.find.' },
            description: 'Keep only these elements, by id.',
          },
          workspaceId: SHARED_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const query: CanvasFindQuery = {}
        const text = str(args, 'query')
        if (text) query.query = text
        const type = str(args, 'type')
        if (type) query.type = type
        const ids = idList(args, 'ids')
        if (ids && ids.length > 0) query.ids = ids
        if (isRecord(args.bbox)) {
          const box = args.bbox
          const numbers = ['x', 'y', 'width', 'height'].map((key) => box[key])
          if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) {
            return failure('invalid', '`bbox` must be an object with finite x, y, width and height.')
          }
          const [x, y, width, height] = numbers as number[]
          query.bbox = { x, y, width, height }
        }
        if (Object.keys(query).length === 0) {
          return failure(
            'invalid',
            'Give at least one of `query`, `type`, `bbox` or `ids` — this tool does not list a whole board. canvas.describe does that.',
          )
        }

        const resolved = await resolveBoard(args, context)
        if ('content' in resolved) return resolved
        const state = await readBoard(resolved.ref)
        if ('content' in state) return state
        const matches = findElements(state.elements, query)
        const { elements, omitted, budgeted } = boundedMatches(matches)
        return success({
          board: boardInfo(resolved.ref, state),
          matched: matches.length,
          elements,
          ...(omitted > 0
            ? {
                omitted,
                note: budgeted
                  ? `${omitted} further match(es) did not fit in one answer. Narrow the search with a \`bbox\` region, a \`type\`, or a more specific \`query\`.`
                  : `${omitted} further match(es) were not returned. Narrow the search with a bbox or a type.`,
              }
            : {}),
        })
      },
    },
    {
      name: 'canvas.edit',
      description:
        "Draw: create, change and delete elements on the board, applied in the order delete → update → create. Returns the ids your creates were given (`tempIds`), any warnings, and the board's lint report. Read the lint — a low score means the LAYOUT is wrong, and the fix is to redesign that part of the board, not to nudge single coordinates. The loop is canvas.describe → canvas.edit → read the lint → canvas.screenshot.",
      inputSchema: {
        type: 'object',
        properties: {
          board: SHARED_PROPERTIES.board,
          delete: {
            type: 'array',
            items: { type: 'string', description: 'The id of an element on this board.' },
            description: 'Ids to remove. Only delete what you drew, or what the person asked you to remove.',
          },
          update: {
            type: 'array',
            items: UPDATE_SCHEMA,
            description: 'Changes to existing elements, each naming an id and the fields to set.',
          },
          create: {
            type: 'array',
            items: CREATE_SCHEMA,
            description:
              'New elements. Create a whole section in one request so arrows can attach to shapes made in the same call by tempId.',
          },
          workspaceId: SHARED_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        // Shape only, and before anything is resolved: the service validates the
        // skeletons against the board it is about to apply them to, and a second
        // opinion here would drift from it.
        if (args.delete === undefined && args.update === undefined && args.create === undefined) {
          return failure('invalid_edit', 'An edit must name at least one of `delete`, `update` or `create`.')
        }
        const resolved = await resolveBoard(args, context)
        if ('content' in resolved) return resolved
        const request: CanvasEditRequest = {}
        if (args.delete !== undefined) request.delete = args.delete as CanvasEditRequest['delete']
        if (args.update !== undefined) request.update = args.update as CanvasEditRequest['update']
        if (args.create !== undefined) request.create = args.create as CanvasEditRequest['create']

        const board = await ensureBoard(resolved.ref)
        if ('content' in board) return board
        const edited = await service.edit(resolved.ref, request, actorOf(resolved.workspaceId, context))
        if (!edited.ok) return canvasFailure(edited.error)
        const { state, result } = edited.value
        return success({
          board: boardInfo(resolved.ref, state),
          created: result.created,
          updated: result.updated,
          deleted: result.deleted,
          tempIds: result.tempIds,
          warnings: result.warnings,
          lint: boundedLint(result.lint ?? lintScene(state.elements), EDIT_LINT_ISSUES),
        })
      },
    },
    {
      name: 'canvas.layout',
      description:
        'Arrange elements that already exist: align them on an edge or a centre line, distribute them evenly, stack them in a row or a column with a fixed gap, group or ungroup them, lock or unlock them. Straighter and cheaper than recomputing coordinates by hand. Read `warnings`: an element this format cannot re-describe — a freehand stroke, an image — is named there and was NOT moved.',
      inputSchema: {
        type: 'object',
        properties: {
          board: SHARED_PROPERTIES.board,
          op: {
            type: 'string',
            enum: ['align', 'distribute', 'stack', 'group', 'ungroup', 'lock', 'unlock'],
            description:
              'What to do: align (to an edge or centre line), distribute (equal space between), stack (lay out in order with a fixed gap), group, ungroup, lock, unlock.',
          },
          elementIds: {
            type: 'array',
            items: { type: 'string', description: 'An element id from canvas.describe or canvas.find.' },
            description: 'The elements to arrange, in the order they should be stacked or distributed.',
          },
          to: {
            type: 'string',
            enum: ['left', 'right', 'top', 'bottom', 'center-x', 'center-y'],
            description: 'align only: the edge or centre line to align on.',
          },
          direction: {
            type: 'string',
            enum: ['horizontal', 'vertical'],
            description: 'distribute and stack: the axis to lay the elements out along.',
          },
          gap: {
            type: 'number',
            description: 'stack only: the space between neighbours in pixels; 80-120 reads well.',
          },
          workspaceId: SHARED_PROPERTIES.workspaceId,
        },
        required: ['op', 'elementIds'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        // Enough of a check to build a typed request; what the op means for
        // these particular elements is the service's call, not this one's.
        const op = str(args, 'op') as CanvasLayoutRequest['op'] | null
        const elementIds = idList(args, 'elementIds')
        if (!op || !LAYOUT_OPS.includes(op)) {
          return failure('invalid', `\`op\` must be one of ${LAYOUT_OPS.join(', ')}.`)
        }
        if (!elementIds) return failure('invalid', '`elementIds` must be an array of element ids.')
        const resolved = await resolveBoard(args, context)
        if ('content' in resolved) return resolved
        const request: CanvasLayoutRequest = { op, elementIds }
        const to = str(args, 'to')
        if (to) request.to = to as CanvasLayoutRequest['to']
        const direction = str(args, 'direction')
        if (direction) request.direction = direction as CanvasLayoutRequest['direction']
        const gap = num(args, 'gap')
        if (gap !== null) request.gap = gap

        const board = await ensureBoard(resolved.ref)
        if ('content' in board) return board
        const laid = await service.layout(resolved.ref, request, actorOf(resolved.workspaceId, context))
        if (!laid.ok) return canvasFailure(laid.error)
        const { state, warnings } = laid.value
        return success({
          board: boardInfo(resolved.ref, state),
          op,
          elementIds,
          warnings,
          lint: boundedLint(lintScene(state.elements), EDIT_LINT_ISSUES),
        })
      },
    },
    {
      name: 'canvas.import',
      description:
        'Bring a diagram onto the board. `mermaid` turns flowchart, sequence, class, entity-relationship and state diagrams into editable shapes you can then tidy up; any other kind arrives as a single image element you cannot edit. `scene` takes a scene JSON document. `mode: merge` (the default) adds to what is there; `mode: replace` CLEARS the board first and destroys whatever the person had drawn on it, so use it only when they asked for exactly that. Give one of `mermaid` or `scene`, not both.',
      inputSchema: {
        type: 'object',
        properties: {
          board: SHARED_PROPERTIES.board,
          mermaid: {
            type: 'string',
            description:
              'Mermaid source. flowchart, sequenceDiagram, classDiagram, erDiagram and stateDiagram become editable shapes; anything else becomes one image element.',
          },
          scene: {
            type: 'object',
            description: 'A scene JSON document (the contents of an .excalidraw file) to bring in.',
            additionalProperties: true,
          },
          mode: {
            type: 'string',
            enum: ['merge', 'replace'],
            description:
              '"merge" (the default) adds the diagram to the board; "replace" empties the board first, which is destructive and needs the person to have asked for it.',
          },
          workspaceId: SHARED_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const mermaid = str(args, 'mermaid')
        const scene = args.scene
        const hasScene = scene !== undefined && scene !== null
        if (Boolean(mermaid) === hasScene) {
          return failure('invalid', 'Give exactly one of `mermaid` or `scene`.')
        }
        const mode = str(args, 'mode') === 'replace' ? 'replace' : 'merge'
        const resolved = await resolveBoard(args, context)
        if ('content' in resolved) return resolved
        const board = await ensureBoard(resolved.ref)
        if ('content' in board) return board
        const imported = await service.importContent(
          resolved.ref,
          mermaid ? { mermaid, mode } : { scene, mode },
          actorOf(resolved.workspaceId, context),
        )
        if (!imported.ok) return canvasFailure(imported.error)
        const { state, result } = imported.value
        return success({
          board: boardInfo(resolved.ref, state),
          mode,
          source: mermaid ? 'mermaid' : 'scene',
          created: result.created,
          deleted: result.deleted,
          tempIds: result.tempIds,
          warnings: result.warnings,
          lint: boundedLint(result.lint ?? lintScene(state.elements), EDIT_LINT_ISSUES),
        })
      },
    },
    {
      name: 'canvas.screenshot',
      description:
        'A picture of the board, or of `elementIds` alone, as an image block with a one-line caption. The lint report canvas.edit already returns is the cheap check: take a screenshot after a substantial change, or when you need to judge the drawing the way a person sees it, not after every edit. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          board: SHARED_PROPERTIES.board,
          elementIds: {
            type: 'array',
            items: { type: 'string', description: 'An element id from canvas.describe or canvas.find.' },
            description:
              'Capture only these elements instead of the whole board. The way to photograph one region of a big board.',
          },
          maxEdge: {
            type: 'number',
            description:
              'Longest edge of the image in pixels. Lower it when a capture comes back too large; the default already fits the wire.',
          },
          background: { type: 'boolean', description: 'Draw the board background behind the elements. Default true.' },
          dark: {
            type: 'boolean',
            description: 'Render in the dark theme, as a person using dark mode sees the board.',
          },
          workspaceId: SHARED_PROPERTIES.workspaceId,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const resolved = await resolveBoard(args, context)
        if ('content' in resolved) return resolved
        const state = await readBoard(resolved.ref)
        if ('content' in state) return state
        const elementIds = idList(args, 'elementIds')
        const maxEdge = num(args, 'maxEdge')
        const background = boolOrNull(args, 'background')
        const dark = boolOrNull(args, 'dark')
        const shot = await service.screenshot(resolved.ref, {
          ...(elementIds && elementIds.length > 0 ? { elementIds } : {}),
          ...(maxEdge !== null ? { maxEdge } : {}),
          ...(background !== null ? { background } : {}),
          ...(dark !== null ? { dark } : {}),
        })
        if (!shot.ok) return canvasFailure(shot.error)
        const board = boardInfo(resolved.ref, state)
        const name = canvasBoardName(state.path || resolved.ref.path)
        const captured = elementIds && elementIds.length > 0 ? elementIds.length : liveElements(state).length
        // The image rides in the content block ONLY. Repeating the base64 in
        // `structuredContent` would double an already large payload on a wire
        // that serialises the result twice.
        return success(
          {
            board,
            width: shot.value.width,
            height: shot.value.height,
            mimeType: shot.value.mimeType,
            capturedElements: captured,
            caption: `${name}: ${shot.value.width}x${shot.value.height} ${shot.value.mimeType}, ${captured} element(s).`,
          },
          { data: shot.value.data, mimeType: shot.value.mimeType },
        )
      },
    },
  ]

  // The Canvas module's switch reaches this surface the way a module-contributed
  // tool's does: the tool stays listed so an agent learns the capability exists,
  // and a call while it is off answers one plain, actionable sentence in the
  // gateway's own words instead of running against a service nobody asked for.
  return tools.map((tool) => ({
    ...tool,
    handler: async (args, context) =>
      deps.isCanvasEnabled()
        ? tool.handler(args, context)
        : failure(
            'canvas_module_disabled',
            'The Canvas module is disabled. Enable it in Settings → Modules to use canvas tools.',
          ),
  }))
}

const LAYOUT_OPS: ReadonlyArray<CanvasLayoutRequest['op']> = [
  'align',
  'distribute',
  'stack',
  'group',
  'ungroup',
  'lock',
  'unlock',
]

function liveElements(state: CanvasBoardState): CanvasBoardState['elements'] {
  return state.elements.filter((element) => element.isDeleted !== true)
}

function newestFirst<T extends { modifiedAt: number; path: string }>(boards: readonly T[]): T[] {
  return [...boards].sort((a, b) => b.modifiedAt - a.modifiedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
