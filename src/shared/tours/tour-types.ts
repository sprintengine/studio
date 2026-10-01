// Diff tours: an agent's guided walkthrough of its own changes, played inside
// the Diff viewer one step at a time.
//
// The shapes here cross three boundaries — the MCP gateway (what an agent
// writes), the app-data store (what survives a restart) and IPC (what the Diff
// viewer plays) — so they live in `shared` and hold no behaviour. The rules
// that turn an agent's anchor into lines are in `tour-anchor.ts`; the rules
// that turn an agent's JSON into a request are in `tour-input.ts`.

/** Bumped when the stored shape changes in a way an old reader would misread. */
export const TOUR_SCHEMA_VERSION = 1

/** Which lines the tour is about. */
export type TourChanges =
  /** The calling agent's own changelist: the uncommitted files it edited. */
  | { kind: 'changelist' }
  /** Everything uncommitted in the checkout, HEAD → working tree. */
  | { kind: 'worktree' }
  /** A committed range, pinned to the two SHAs it resolved to. */
  | { kind: 'range'; base: string; head: string }

/** The side of the diff a step points at. `new` is the file as it is now. */
export type TourSide = 'new' | 'old'

/** What a step is for. `caveat` is an honest weak spot, and is drawn as one. */
export type TourStepKind = 'explain' | 'context' | 'caveat'

/** One step as the agent writes it. Exactly one of the four anchors is set. */
export type TourStepInput = {
  id: string
  title: string
  /** Markdown. */
  body: string
  /** One line for the step list's tooltip. */
  hoverTip?: string
  kind?: TourStepKind
  path: string
  /** A renamed file's path before the change. */
  oldPath?: string
  side: TourSide
  lines?: [number, number]
  /** 1-based: hunk 1 is the file's first change. */
  hunk?: number
  /** Text that appears exactly once on the step's side of the file. */
  match?: string
  /** With `match`: how many lines from the matched line the step covers. */
  lineCount?: number
  fileOnly?: true
}

/**
 * Where a step lives, once resolved. Everything a later re-read needs to find
 * the same lines again after the file moved under it.
 */
export type TourAnchor = {
  path: string
  oldPath?: string
  side: TourSide
  /** Null for a file-level step. */
  startLine: number | null
  endLine: number | null
  /** The `-U0` hunk the lines sat in, named by its body (`hunkFingerprint`). */
  hunk?: { index: number; fingerprint: string }
  /**
   * The anchored lines as text, each trimmed: the first and last, and the
   * whole range (`body`) — what a later read compares to decide the lines are
   * still the same lines.
   */
  snippet?: { first: string; last: string; body?: string }
}

/** What the file was, for the viewer: it decides how the step is drawn. */
export type TourFileStatus = 'new' | 'modified' | 'deleted' | 'renamed'

/** A file the viewer cannot open as text; the step becomes a file card. */
export type TourFileUnreadable = 'binary' | 'too-large' | null

/** Live state of one step against the files as they are now. */
export type TourStepLiveStatus = 'ok' | 'moved' | 'gone'

export type TourStep = {
  id: string
  title: string
  body: string
  hoverTip?: string
  kind: TourStepKind
  anchor: TourAnchor
  fileStatus: TourFileStatus
  unreadable: TourFileUnreadable
  /**
   * What the step pointed at when it was written: up to ~80 lines in unified
   * form (`+`, `-`, ` ` prefixes). Kept so a moved or gone step still shows
   * what the agent was talking about.
   */
  excerpt: string[]
}

/** The revisions the viewer reads the two sides from. */
export type TourRevisions = {
  /** `HEAD`'s SHA at creation, or the range's base SHA. */
  base: string
  /** A SHA for a range, or `worktree`. */
  head: string | 'worktree'
}

export type TourAuthor = {
  agentId: string | null
  agentName: string | null
  cliId: string | null
}

/** One question the owner asked from a callout, and where it is. */
export type TourAsk = {
  id: string
  stepId: string
  text: string
  /** queued: waiting for the agent to be ready; sent: typed in, agent answering; answered: its turn ended. */
  state: 'queued' | 'sent' | 'answered' | 'cancelled' | 'failed'
  at: number
  error?: string
}

/** What the owner's viewer is doing with the tour; reported back so `tour.status` can say. */
export type TourPlayback = {
  started: boolean
  currentStepId: string | null
  visited: string[]
  follow: boolean
}

export type Tour = {
  schemaVersion: typeof TOUR_SCHEMA_VERSION
  id: string
  workspaceId: string
  repoRoot: string
  title: string
  overview?: string
  changes: TourChanges
  revisions: TourRevisions
  author: TourAuthor
  createdAt: number
  updatedAt: number
  closed: boolean
  steps: TourStep[]
  playback: TourPlayback
  /** The step the agent last pointed at with `tour.goto`, and when. */
  pointer: { stepId: string; at: number } | null
  asks: TourAsk[]
}

/** A tour with every step's live position, as the viewer plays it. */
export type LiveTourStep = TourStep & {
  status: TourStepLiveStatus
  /** Where the lines are NOW; equal to the anchor's unless re-found elsewhere. */
  startLine: number | null
  endLine: number | null
}

export type LiveTour = Omit<Tour, 'steps'> & { steps: LiveTourStep[] }

export type TourSummary = {
  id: string
  title: string
  stepCount: number
  authorName: string | null
  createdAt: number
  updatedAt: number
  started: boolean
  closed: boolean
}

/** Main → window pushes. */
export type TourChangedEvent = { workspaceId: string; tourId: string }
export type TourRevealRequest = { requestId: string; workspaceId: string; tourId: string; repoRoot: string }
export type TourGotoRequest = { requestId: string; workspaceId: string; tourId: string; stepId: string }
export type TourGotoAnswer = { requestId: string; moved: boolean; reason: string }

export type TourResult<T> = { ok: true; value: T } | { ok: false; message: string }
