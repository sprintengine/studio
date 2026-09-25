// Putting a file, or a file's diff, in front of the person — at the lines an
// agent means.
//
// An agent working in a Studio terminal used to have one way to point at code:
// paste a path into its reply and hope the person went looking. The
// `editor.open`, `editor.open_diff` and `editor.state` tools let it open the
// file instead, scrolled to and highlighting the range it is talking about, and
// the location shape below is the one thing they all speak. It is exported from
// here, not from main, because more than one surface builds on it: the tools,
// the window that performs the open, and a guided diff walkthrough that walks
// the person through a change one location at a time.
//
// Pure and Node-free: main, preload and the renderer all read it.

import type { BranchStepSelection } from './ipc/git'

/** 1-based, inclusive, the way Monaco and every agent's `file:line` count. */
export type EditorRange = {
  startLine: number
  endLine?: number
  startColumn?: number
  endColumn?: number
}

/**
 * One place in one file.
 *
 * `path` is absolute, or relative to the agent's working directory — the
 * spelling an agent already has in hand. `view: 'diff'` opens the file's
 * uncommitted diff rather than the file; `side` says which side of that diff
 * the range counts on (the new text by default).
 */
export type EditorLocation = {
  path: string
  range?: EditorRange
  view?: 'file' | 'diff'
  side?: 'modified' | 'original'
}

/** How many files one `editor.open` may put in front of the person. */
export const EDITOR_OPEN_MAX_FILES = 8
/** A note is one line above the editor, not a message. */
export const EDITOR_NOTE_MAX_CHARS = 140

/**
 * What the person could see when the tool answered.
 *
 * `foreground` — the window showing the workspace opened it on top.
 * `background` — the person was typing, so it opened behind their tab.
 * `not_visible` — no window is showing the workspace (or the window is
 * minimized): it opens when they come back to it, and not before.
 */
export type EditorRevealShown = 'foreground' | 'background' | 'not_visible'

export type EditorRevealFileStatus = 'opened' | 'awaiting_owner' | 'refused'

export type EditorRevealReason = 'outside_workspace' | 'sensitive_path' | 'not_found' | 'binary' | 'too_large'

export type EditorDiffChanges = 'uncommitted' | 'branch' | 'staged' | 'unstaged' | 'commit'

// ─── Parsing the tool arguments ───────────────────────────────────────────────

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null
}

/**
 * A range as the tools accept it. Every field is a positive integer, and an
 * end before its start is refused rather than silently swapped — an agent that
 * wrote `{startLine: 40, endLine: 12}` meant something, and guessing which half
 * was the typo would highlight the wrong code with confidence.
 */
export function parseEditorRange(value: unknown): Parsed<EditorRange> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: '`range` must be an object with a 1-based `startLine`.' }
  }
  const raw = value as Record<string, unknown>
  const startLine = positiveInteger(raw.startLine)
  if (startLine === null) return { ok: false, message: '`range.startLine` must be a positive integer (1-based).' }
  const range: EditorRange = { startLine }
  for (const key of ['endLine', 'startColumn', 'endColumn'] as const) {
    if (raw[key] === undefined) continue
    const parsed = positiveInteger(raw[key])
    if (parsed === null) return { ok: false, message: `\`range.${key}\` must be a positive integer (1-based).` }
    range[key] = parsed
  }
  if (range.endLine !== undefined && range.endLine < startLine) {
    return { ok: false, message: '`range.endLine` is before `range.startLine`.' }
  }
  return { ok: true, value: range }
}

export function parseEditorLocation(value: unknown): Parsed<EditorLocation> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'Each location must be an object with a `path`.' }
  }
  const raw = value as Record<string, unknown>
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (!path) return { ok: false, message: 'Each location needs a non-empty `path`.' }
  if (path.includes('\0')) return { ok: false, message: '`path` contains a NUL byte.' }
  const location: EditorLocation = { path }
  if (raw.range !== undefined) {
    const range = parseEditorRange(raw.range)
    if (!range.ok) return range
    location.range = range.value
  }
  if (raw.view !== undefined) {
    if (raw.view !== 'file' && raw.view !== 'diff') return { ok: false, message: '`view` must be "file" or "diff".' }
    location.view = raw.view
  }
  if (raw.side !== undefined) {
    if (raw.side !== 'modified' && raw.side !== 'original') {
      return { ok: false, message: '`side` must be "modified" or "original".' }
    }
    location.side = raw.side
  }
  return { ok: true, value: location }
}

/** The note, trimmed, or null. Past the cap it is refused, not cut mid-word. */
export function parseEditorNote(value: unknown): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: '`note` must be a string.' }
  const note = value.replace(/\s+/g, ' ').trim()
  if (!note) return { ok: true, value: null }
  if (note.length > EDITOR_NOTE_MAX_CHARS) {
    return { ok: false, message: `\`note\` is ${note.length} characters; keep it to ${EDITOR_NOTE_MAX_CHARS}.` }
  }
  return { ok: true, value: note }
}

/** A range clamped into a file of `lineCount` lines — what the editor can actually show. */
export function clampEditorRange(range: EditorRange, lineCount: number): EditorRange {
  const last = Math.max(1, lineCount)
  const startLine = Math.min(range.startLine, last)
  const endLine = Math.min(Math.max(range.endLine ?? startLine, startLine), last)
  return {
    startLine,
    endLine,
    ...(range.startColumn !== undefined ? { startColumn: range.startColumn } : {}),
    ...(range.endColumn !== undefined ? { endColumn: range.endColumn } : {}),
  }
}

// ─── Main ⇄ window ────────────────────────────────────────────────────────────

/** Main → workspace windows: open this. */
export const EDITOR_REVEAL_REQUEST_CHANNEL = 'editor-reveal:request'
/** Window → main: what I did with it. */
export const EDITOR_REVEAL_ACK_CHANNEL = 'editor-reveal:ack'
/** Main → workspace windows: which workspaces hold a reveal nobody has seen yet. */
export const EDITOR_REVEAL_PENDING_CHANNEL = 'editor-reveal:pending'
/** Window → main (invoke): the workspace became visible here; hand me what waited for it. */
export const EDITOR_REVEAL_CLAIM_CHANNEL = 'editor-reveal:claim'
/** Window → main (invoke): the pending set, for a window that just opened. */
export const EDITOR_REVEAL_LIST_PENDING_CHANNEL = 'editor-reveal:list-pending'
/** Main → workspace windows: what are you showing for this workspace? */
export const EDITOR_STATE_QUERY_CHANNEL = 'editor-reveal:state-query'
/** Window → main: the answer. */
export const EDITOR_STATE_REPLY_CHANNEL = 'editor-reveal:state-reply'

/** One file the window opens, already resolved and cleared by main. */
export type EditorRevealFileTarget = {
  /** Absolute, in this machine's spelling — what the window reads and opens. */
  path: string
  /** What the person and the agent call it: workspace-relative, or as the agent spelled it. */
  displayPath: string
  name: string
  range: EditorRange | null
}

/**
 * A diff the window opens. Main has already chosen the repository and counted
 * the files; the window only routes it to the surface the person prefers.
 */
export type EditorRevealDiffTarget = {
  repoRoot: string
  /** The working-tree side the standalone viewer opens on; null for a branch or commit view. */
  scope: 'staged' | 'unstaged' | null
  /** The branch step the pane's viewer opens on. Null for the working-tree views. */
  step: BranchStepSelection | null
  /** Filter to one changelist (`agent:<agentId>`), or null for every change. */
  changelistId: string | null
  /** Show only these repo-relative paths, with a "Show all" way out. Null shows everything. */
  paths: string[] | null
  /** How many files the view would hold without `paths`, for "Showing 3 of 40". */
  totalChangedFiles: number
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
  focusRange: EditorRange | null
  focusSide: 'modified' | 'original'
}

export type EditorRevealRequest = {
  requestId: string
  workspaceId: string
  /** Who is asking, for "Claude wants to show you …". Null reads as "An agent". */
  agentName: string | null
  note: string | null
  files: EditorRevealFileTarget[]
  /** Outside anything the agent may open on its own: the person says Open or Dismiss. */
  awaiting: EditorRevealFileTarget[]
  diff: EditorRevealDiffTarget | null
}

export type EditorRevealAck =
  { requestId: string; outcome: 'opened'; shown: EditorRevealShown } | { requestId: string; outcome: 'declined' }

export type EditorStateQuery = { requestId: string; workspaceId: string }

export type EditorViewState = {
  path: string
  view: 'file' | 'diff'
  visibleRange: { startLine: number; endLine: number } | null
  selection: EditorRange | null
}

export type EditorWindowState = {
  /** The window is on screen (not minimized, not hidden). */
  windowVisible: boolean
  active: EditorViewState | null
  openFiles: string[]
  /** Files waiting on the person's Open / Dismiss in this window. */
  awaitingOwner: number
  /**
   * Where files open for this person: the in-app editor, or the pop-out editor
   * window. `active` and `openFiles` describe the in-app editor only.
   */
  fileSurface?: 'app' | 'popout'
}

export type EditorStateReply =
  { requestId: string; outcome: 'answered'; state: EditorWindowState } | { requestId: string; outcome: 'declined' }

/** The file name a tab wears, from either separator. */
export function editorFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
