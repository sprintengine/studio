import { useSyncExternalStore } from 'react'
import type * as Monaco from 'monaco-editor'

import type { EditorRange, EditorViewState } from '../../../shared/editor-reveal'

// The renderer's small shared state for an agent's editor reveal (the
// editor.* tools), kept out of the workspace store on purpose: none of it is
// persisted, none of it is workspace data, and all of it is gone when the
// window is.
//
//  - Where to land in a file once its editor mounts (`queueEditorLanding`),
//    because a tab opened behind the person's current one mounts only when
//    they switch to it — the range has to wait for them, not for a timer.
//  - Which mounted editors exist, so "is the person typing" and editor.state
//    can be answered without reaching into a component.
//  - The one-line note / "wants to show you" strip per workspace.
//  - Which workspaces hold a reveal no window has shown yet, for the sidebar.

// ─── Landing: where an editor goes once it has the file ──────────────────────

export type EditorLanding = {
  range: EditorRange
  /** An agent's reveal never moves the keyboard; the person's own navigation does. */
  takeFocus: boolean
  /** Paint the short "just changed" highlight over the range. */
  highlight: boolean
}

const landings = new Map<string, EditorLanding>()
const landingListeners = new Set<() => void>()
const landingKey = (workspaceId: string, filePath: string): string => `${workspaceId}\u0000${filePath}`

export function queueEditorLanding(workspaceId: string, filePath: string, landing: EditorLanding): void {
  landings.set(landingKey(workspaceId, filePath), landing)
  for (const listener of [...landingListeners]) listener()
}

/** Take (and forget) the landing waiting for this file, if any. */
export function takeEditorLanding(workspaceId: string, filePath: string): EditorLanding | null {
  const key = landingKey(workspaceId, filePath)
  const landing = landings.get(key) ?? null
  if (landing) landings.delete(key)
  return landing
}

export function peekEditorLanding(workspaceId: string, filePath: string): EditorLanding | null {
  return landings.get(landingKey(workspaceId, filePath)) ?? null
}

/** Told whenever a landing is queued, so a mounted editor can take its own at once. */
export function onEditorLandingQueued(listener: () => void): () => void {
  landingListeners.add(listener)
  return () => landingListeners.delete(listener)
}

// ─── The mounted editors ──────────────────────────────────────────────────────

/** How recent a keystroke still counts as "the person is typing". */
export const OWNER_TYPING_WINDOW_MS = 3_000

type MountedEditor = {
  workspaceId: string
  filePath: string
  editor: Monaco.editor.IStandaloneCodeEditor
  lastKeyAt: number
  lastFocusedAt: number
}

const mounted = new Set<MountedEditor>()

/**
 * Register a mounted workspace editor. Returns the unregister. Keystrokes and
 * focus are sampled from the editor itself, so nothing here depends on how a
 * panel is laid out.
 */
export function registerMountedEditor(
  workspaceId: string,
  filePath: string,
  editor: Monaco.editor.IStandaloneCodeEditor,
): () => void {
  const entry: MountedEditor = { workspaceId, filePath, editor, lastKeyAt: 0, lastFocusedAt: 0 }
  mounted.add(entry)
  const keys = editor.onKeyDown(() => {
    entry.lastKeyAt = Date.now()
  })
  const focus = editor.onDidFocusEditorText(() => {
    entry.lastFocusedAt = Date.now()
  })
  return () => {
    mounted.delete(entry)
    keys.dispose()
    focus.dispose()
  }
}

// The last keystroke anywhere in this window, for the typing check below. A
// terminal, the chat composer or a pane's input is as much "typing" as the
// editor: an open that selects a tab over the one holding the caret takes the
// keyboard away just the same.
let lastWindowKeyAt = 0

/** Installed once per window by the reveal hook; returns the uninstall. */
export function trackWindowKeystrokes(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  const onKey = (): void => {
    lastWindowKeyAt = Date.now()
  }
  target.addEventListener('keydown', onKey, true)
  return () => target.removeEventListener('keydown', onKey, true)
}

function isEditable(element: Element | null): boolean {
  if (!element) return false
  const tag = element.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const type = (element as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  return (element as HTMLElement).isContentEditable === true
}

/**
 * The person is typing: this workspace's editor holds the keyboard or took a
 * keystroke in the last few seconds, or the caret is in any other text field
 * of the window (a terminal, a composer) and a key went down just now. An
 * agent's reveal then opens behind their tab instead of swapping what they are
 * typing into.
 */
export function isOwnerTyping(
  workspaceId: string,
  now: number = Date.now(),
  activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement,
): boolean {
  for (const entry of mounted) {
    if (entry.workspaceId !== workspaceId) continue
    if (entry.editor.hasTextFocus()) return true
    if (now - entry.lastKeyAt < OWNER_TYPING_WINDOW_MS) return true
  }
  return isEditable(activeElement) && now - lastWindowKeyAt < OWNER_TYPING_WINDOW_MS
}

/** The editor-only half, for the pop-out window (it has no workspace shell). */
export function isEditorBeingTyped(
  editor: Pick<Monaco.editor.ICodeEditor, 'hasTextFocus'> | null,
  lastKeyAt: number,
  now: number = Date.now(),
): boolean {
  if (!editor) return false
  return editor.hasTextFocus() || now - lastKeyAt < OWNER_TYPING_WINDOW_MS
}

/** The editor the person last had in hand for this workspace, as editor.state reports it. */
export function activeEditorView(workspaceId: string, activeFilePath: string | null): EditorViewState | null {
  let best: MountedEditor | null = null
  for (const entry of mounted) {
    if (entry.workspaceId !== workspaceId) continue
    if (activeFilePath && entry.filePath === activeFilePath) {
      best = entry
      break
    }
    if (!best || entry.lastFocusedAt > best.lastFocusedAt) best = entry
  }
  if (!best) return activeFilePath ? { path: activeFilePath, view: 'file', visibleRange: null, selection: null } : null
  const ranges = best.editor.getVisibleRanges()
  const first = ranges[0]
  const last = ranges[ranges.length - 1]
  const selection = best.editor.getSelection()
  return {
    path: best.filePath,
    view: 'file',
    visibleRange: first && last ? { startLine: first.startLineNumber, endLine: last.endLineNumber } : null,
    selection: selection
      ? {
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber,
          startColumn: selection.startColumn,
          endColumn: selection.endColumn,
        }
      : null,
  }
}

// ─── The "just changed" highlight ─────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

/** The pulse duration the tokens define, in ms; the CSS animation reads the same variable. */
function pulseDurationMs(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-pulse').trim()
    const value = Number.parseFloat(raw)
    if (!Number.isFinite(value)) return 620
    return raw.endsWith('ms') ? value : value * 1000
  } catch {
    return 620
  }
}

/**
 * Scroll `range` into the middle of the editor and mark it.
 *
 * With motion: a tint that fades over one pulse duration, then the decoration
 * is removed. With reduced motion: a steady tint that stays until the person
 * next clicks or types in that editor — the same information with nothing
 * moving. Returns the cleanup, for an editor that unmounts first.
 */
export function revealEditorRange(
  editor: Pick<
    Monaco.editor.ICodeEditor,
    'getModel' | 'revealLinesInCenter' | 'setPosition' | 'createDecorationsCollection' | 'onMouseDown' | 'onKeyDown'
  >,
  range: EditorRange,
  options: { highlight: boolean; moveCaret: boolean },
): () => void {
  const model = editor.getModel()
  const lineCount = model?.getLineCount() ?? range.startLine
  const startLine = Math.min(Math.max(range.startLine, 1), Math.max(lineCount, 1))
  const endLine = Math.min(Math.max(range.endLine ?? startLine, startLine), Math.max(lineCount, 1))
  editor.revealLinesInCenter(startLine, endLine)
  if (options.moveCaret) editor.setPosition({ lineNumber: startLine, column: range.startColumn ?? 1 })
  if (!options.highlight) return () => {}

  const steady = prefersReducedMotion()
  const decorations = editor.createDecorationsCollection([
    {
      range: {
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        className: steady ? 'agent-reveal-range agent-reveal-range-steady' : 'agent-reveal-range',
      },
    },
  ])
  let cleared = false
  const disposables: Array<{ dispose(): void }> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (cleared) return
    cleared = true
    if (timer) clearTimeout(timer)
    for (const disposable of disposables) disposable.dispose()
    decorations.clear()
  }
  if (steady) {
    disposables.push(editor.onMouseDown(clear), editor.onKeyDown(clear))
  } else {
    timer = setTimeout(clear, pulseDurationMs())
  }
  return clear
}

// ─── Notices: the note, and "wants to show you" ──────────────────────────────

export type AgentRevealNotice = {
  requestId: string
  agentName: string | null
  note: string | null
  /** Files outside the workspace, waiting on Open or Dismiss. */
  awaiting: Array<{ path: string; displayPath: string; name: string; range: EditorRange | null }>
}

const notices = new Map<string, AgentRevealNotice>()
const noticeListeners = new Set<() => void>()
const emitNotices = (): void => {
  for (const listener of [...noticeListeners]) listener()
}

/** Latest wins: a second reveal replaces the first one's strip. */
export function setAgentRevealNotice(workspaceId: string, notice: AgentRevealNotice | null): void {
  if (notice && (notice.note || notice.awaiting.length > 0)) notices.set(workspaceId, notice)
  else notices.delete(workspaceId)
  emitNotices()
}

export function getAgentRevealNotice(workspaceId: string): AgentRevealNotice | null {
  return notices.get(workspaceId) ?? null
}

export function useAgentRevealNotice(workspaceId: string): AgentRevealNotice | null {
  return useSyncExternalStore(
    (listener) => {
      noticeListeners.add(listener)
      return () => noticeListeners.delete(listener)
    },
    () => notices.get(workspaceId) ?? null,
    () => null,
  )
}

// ─── Workspaces holding a reveal nobody has seen ─────────────────────────────

let pendingWorkspaces: ReadonlySet<string> = new Set()
const pendingListeners = new Set<() => void>()

export function setPendingRevealWorkspaces(workspaceIds: readonly string[]): void {
  pendingWorkspaces = new Set(workspaceIds)
  for (const listener of [...pendingListeners]) listener()
}

export function usePendingEditorReveal(workspaceId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      pendingListeners.add(listener)
      return () => pendingListeners.delete(listener)
    },
    () => pendingWorkspaces.has(workspaceId),
    () => false,
  )
}

export function hasPendingEditorReveal(workspaceId: string): boolean {
  return pendingWorkspaces.has(workspaceId)
}
