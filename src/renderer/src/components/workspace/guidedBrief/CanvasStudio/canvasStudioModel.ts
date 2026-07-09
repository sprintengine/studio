import type { DesignArtifactIndex } from '../designArtifacts'
import type { StageChipState, StageLiveStatus } from '../stageReadiness'
import { stageChipState } from '../stageReadiness'

// Pure model for the canvas-first studio shell (MC-1510). No React here so the
// switcher/bubble decisions are unit-tested in guidedBriefFlow.test.ts against
// the same inputs the shell renders from.

// A navigable screen on the canvas — one real HTML page in the frontend-design
// preset. `id` is the workspace-root-relative path (the selection key that
// drives `activeDesignArtifactPath`).
export type CanvasScreen = {
  id: string
  name: string
}

// The screen switcher rides inline in the toolbar pill up to this many screens;
// beyond it, the switcher collapses to a "Screens · N" button that opens the
// floating drawer. Threshold from the decision record
// (backlog/2026-07-07-canvas-first-studio.md, resolved question 1).
export const INLINE_SCREEN_SWITCHER_MAX = 6

// What the toolbar pill's leading region navigates on the canvas:
// - `screens`   — frontend-design HTML pages (inline switcher ≤6, drawer 7+).
// - `documents` — a text stage's small fixed document set (brief/plan/preview).
// - `gallery`   — design-system Screen/Gallery toggle placeholder (T6 wires it).
// - `none`      — no navigation (single artifact on the canvas).
export type CanvasStudioNav =
  | {
      kind: 'screens'
      screens: CanvasScreen[]
      activeId: string | null
      onSelect: (id: string) => void
    }
  | {
      kind: 'documents'
      documents: Array<{ id: string; label: string }>
      activeId: string
      onSelect: (id: string) => void
    }
  | { kind: 'gallery' }
  | { kind: 'none' }

export function screenSwitcherMode(screenCount: number): 'inline' | 'drawer' {
  return screenCount > INLINE_SCREEN_SWITCHER_MAX ? 'drawer' : 'inline'
}

// The screens the frontend-design switcher navigates: the real HTML pages from
// the run's design index (the `pages` group), in index order. Non-page files
// (styles, scripts, notes, inspiration) are not screens and never appear in the
// switcher — the canvas is screen-first, per the decision record.
export function canvasScreensFromIndex(index: DesignArtifactIndex): CanvasScreen[] {
  const pages = index.groups.find((group) => group.id === 'pages')
  if (!pages) return []
  return pages.entries.map((entry) => ({ id: entry.relativePath, name: entry.name }))
}

// The collapsed agent-bubble status line, derived from the same live stage
// status (StageChipState, MC-1503) the header chip shows — never parsed output.
// One short clause; the avatar dot carries the tone.
const BUBBLE_STATUS_LINE: Record<StageChipState, string> = {
  working: 'Working',
  'needs-input': 'Waiting for your input',
  ready: 'Ready for review',
  failed: 'Session failed',
  idle: 'Idle',
}

export function bubbleStatusLine(liveStatus: StageLiveStatus | undefined, ready: boolean): string {
  return BUBBLE_STATUS_LINE[stageChipState(liveStatus ?? 'absent', ready)]
}

// Avatar dot tone per chip state — the same grayscale-safe semantics as the
// header chip: warn while waiting on the user, good when ready, error on
// failure, accent while working, muted at rest.
const BUBBLE_DOT_TONE: Record<StageChipState, string> = {
  working: 'var(--accent-primary)',
  'needs-input': 'var(--tone-warn)',
  ready: 'var(--tone-good)',
  failed: 'var(--tone-error)',
  idle: 'var(--text-subtle)',
}

export function bubbleDotTone(liveStatus: StageLiveStatus | undefined, ready: boolean): string {
  return BUBBLE_DOT_TONE[stageChipState(liveStatus ?? 'absent', ready)]
}

// Whether the collapsed bubble should pull the user's eye — a live pending
// question is the one state that does. Drives the attention ring, matching
// ConversationPane's `needs-input` treatment.
export function bubbleNeedsAttention(liveStatus: StageLiveStatus | undefined): boolean {
  return liveStatus === 'needs-input'
}

// Two-letter avatar initials from a specialist name ("Frontend Designer" → "FD",
// "Architect" → "AR"). A single word takes its first two letters.
export function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '··'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}
