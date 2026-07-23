// The shared substrate for the three door surfaces (Roadmap / Automations /
// Reviews) — the "Door substrate" view of mockups/2026-07-20-post-merge-ui-polish
// (#view-doors). The three surfaces landed as copy-paste triplets that drifted:
// loading, empty, and error each grew three dialects, only one rail had keyboard
// navigation, and one error state withheld its rail with no retry. This module is
// the single source for those three shared pieces, so every door reads and behaves
// the same:
//
//   • SurfaceCanvasState — the canvas renders exactly one of three states:
//       loading (spinner + line), empty (glyph + CTA), error (the shared error
//       card, ALWAYS with "Try again", never a dead end, never a blocking dialog).
//   • SurfaceRail — the internal list rail: list semantics (role="list"), a single
//       status dot + title + state line per row, ↑/↓ + j/k keyboard navigation, and
//       one "New …" affordance. The rail is the surface's, never the app sidebar.
//   • BarStatusChip — the one status idiom in the surface bar: a 6 px dot + label,
//       never a competing pill or badge.

import React, { useCallback, useRef } from 'react'

import { GhostButton } from '../../ui/Buttons'
import { InlineNotice } from '../../ui/InlineNotice'
import { Spinner } from '../../ui/Spinner'
import { StatusDot } from '../../ui/StatusDot'
import { FOCUS_RING_CLASS, type StatusTone } from '../../ui/tokens'

// ── SurfaceCanvasState ───────────────────────────────────────────────────────
// The three shared canvas states. Same anatomy on every door; only the copy
// changes. A refresh never re-enters `loading` — that state is for the first read
// only, so populated content never blinks back to a spinner.

export type SurfaceCanvasStateProps =
  | { kind: 'loading'; label: string }
  | {
      kind: 'empty'
      /** The glyph inside the accent-soft circle (an svg or a single character). */
      glyph: React.ReactNode
      title: string
      body?: React.ReactNode
      /** The one call-to-action (never a dead end for a first-time surface). */
      action?: React.ReactNode
    }
  | {
      kind: 'error'
      /** Plain sentence: what happened, in the user's terms. */
      title: string
      /** What it means / the one next step. */
      hint?: string
      /** Raw technical string, shown only behind "Show details". */
      detail?: string
      onRetry: () => void
      /** Label for the retry action; defaults to "Try again". */
      retryLabel?: string
      /** Extra recovery action(s) rendered before "Try again" (e.g. "Open settings"). */
      extraAction?: React.ReactNode
    }

export function SurfaceCanvasState(props: SurfaceCanvasStateProps): JSX.Element {
  if (props.kind === 'loading') {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-[12px] text-[color:var(--text-muted)]">
        <Spinner size={14} />
        {props.label}
      </div>
    )
  }
  if (props.kind === 'empty') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--accent-primary-soft)] text-[18px] text-[color:var(--accent-primary)]">
          {props.glyph}
        </div>
        <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">{props.title}</h3>
        {props.body ? (
          <p className="max-w-[46ch] text-[12px] leading-5 text-[color:var(--text-muted)]">{props.body}</p>
        ) : null}
        {props.action ? <div className="mt-2 flex items-center gap-2">{props.action}</div> : null}
      </div>
    )
  }
  // Error: the shared error card. Non-blocking (never a dialog), always a retry —
  // the rail stays present because the shell, not this canvas, owns the rail.
  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <InlineNotice
        tone="error"
        title={props.title}
        hint={props.hint}
        detail={props.detail}
        className="w-full max-w-md"
        action={
          <>
            {props.extraAction}
            <GhostButton onClick={props.onRetry}>{props.retryLabel ?? 'Try again'}</GhostButton>
          </>
        }
      />
    </div>
  )
}

// ── GlobalSurfaceErrorBoundary ───────────────────────────────────────────────
// A door failure is contained to the door (MC-1835). Without this, any throw in
// a surface's render — or a lazy chunk failing to load — propagated to the root
// and white-screened the whole renderer. The fallback follows the copy-voice
// error shape: state first, blast radius named, two recoveries — remount the
// surface, or close the door and keep working.

interface GlobalSurfaceErrorBoundaryProps {
  /** The door id ("reviews", "sprints", …) — names the surface in the log line. */
  surfaceId: string
  /** Human name for the fallback title ("Reviews hit a problem and stopped"). */
  surfaceLabel: string
  onClose: () => void
  children: React.ReactNode
}

interface GlobalSurfaceErrorBoundaryState {
  failed: boolean
}

export class GlobalSurfaceErrorBoundary extends React.Component<
  GlobalSurfaceErrorBoundaryProps,
  GlobalSurfaceErrorBoundaryState
> {
  state: GlobalSurfaceErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): GlobalSurfaceErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error(`[global-surface] the ${this.props.surfaceId} door crashed`, error)
  }

  componentDidUpdate(previous: GlobalSurfaceErrorBoundaryProps): void {
    // The boundary instance is reused as the operator moves between doors; a
    // failure in one surface must not stick to the next one.
    if (previous.surfaceId !== this.props.surfaceId && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <SurfaceCanvasState
          kind="error"
          title={`${this.props.surfaceLabel} hit a problem and stopped.`}
          hint="The rest of the app is unaffected. Reload the surface, or close it and keep working."
          onRetry={() => this.setState({ failed: false })}
          retryLabel="Reload surface"
          extraAction={<GhostButton onClick={this.props.onClose}>Close</GhostButton>}
        />
      )
    }
    return this.props.children
  }
}

// ── SurfaceRail ──────────────────────────────────────────────────────────────
// The internal list rail shared by every door. A row is a single status dot, a
// title, and a one-line state; selecting it fills the canvas. Row actions live on
// the bar or canvas, never here — the rail stays a calm navigation list.

export interface SurfaceRailRow {
  /** Stable selection id (roadmapRef / automation id / reviewId). */
  id: string
  title: string
  /** The one-line at-a-glance state ("Active · step 3 of 7", "Ran 2h ago · passed"). */
  stateLine: string
  tone: StatusTone
  /** Pulse the dot for a live/running row. */
  pulse?: boolean
  /** Accessible name for the dot when the state line does not already carry it. */
  dotLabel?: string
}

export interface SurfaceRailNewAffordance {
  label: string
  /** The "New …" affordance is itself the current selection (Reviews' create flow). */
  selected?: boolean
  /** Invoked on activate; `anchor` is the button's bottom-left, for popover hosts. */
  onActivate: (anchor: { x: number; y: number }) => void
}

const PLUS_ICON = (
  <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

export function SurfaceRail({
  label,
  rows,
  selectedId,
  onSelect,
  newAffordance,
}: {
  /** The rail's section label ("Roadmaps", "Automations", "Reviews"). */
  label: string
  rows: ReadonlyArray<SurfaceRailRow>
  /** The selected row id, or null (nothing selected / the "New" affordance is). */
  selectedId: string | null
  onSelect: (id: string) => void
  newAffordance: SurfaceRailNewAffordance
}): JSX.Element {
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())

  // ↑/↓ + j/k move the selection through the rows and carry focus with it, so the
  // keyboard and the canvas stay in step. Ignored while typing in a field.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isEditableTarget(event.target) || rows.length === 0) return
      const next = event.key === 'ArrowDown' || event.key === 'j'
      const prev = event.key === 'ArrowUp' || event.key === 'k'
      if (!next && !prev) return
      event.preventDefault()
      const index = selectedId ? rows.findIndex((row) => row.id === selectedId) : -1
      const target = next
        ? rows[Math.min(index + 1, rows.length - 1)] ?? rows[0]
        : rows[Math.max(index - 1, 0)] ?? rows[0]
      if (!target) return
      onSelect(target.id)
      rowRefs.current.get(target.id)?.focus()
    },
    [rows, selectedId, onSelect],
  )

  return (
    <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="px-2 pb-1.5 pt-0.5 text-[11px] font-semibold text-[color:var(--text-subtle)]">{label}</div>
      <ul role="list" aria-label={label} className="flex min-w-0 flex-col gap-0.5">
        {rows.map((row) => {
          const selected = row.id === selectedId
          return (
            <li key={row.id}>
              <button
                ref={(node) => {
                  rowRefs.current.set(row.id, node)
                }}
                type="button"
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(row.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
                  selected ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]'
                }`}
              >
                <StatusDot tone={row.tone} pulse={row.pulse} size={7} label={row.dotLabel} className="shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium text-[color:var(--text-strong)]" title={row.title}>
                    {row.title}
                  </span>
                  <span className="truncate text-[10.5px] text-[color:var(--text-subtle)]">{row.stateLine}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        aria-current={newAffordance.selected ? 'true' : undefined}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          newAffordance.onActivate({ x: rect.left, y: rect.bottom })
        }}
        className={`mt-1.5 flex w-full items-center gap-2 rounded-md border border-dashed border-[color:var(--border-default)] px-2 py-1.5 text-left text-[12px] transition-colors ${FOCUS_RING_CLASS} ${
          newAffordance.selected
            ? 'bg-[color:var(--bg-selected)] font-medium text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
        }`}
      >
        {PLUS_ICON}
        {newAffordance.label}
      </button>
    </div>
  )
}

// ── BarStatusChip ────────────────────────────────────────────────────────────
// The one status idiom in the surface bar: a 6 px dot + a short label. Never a
// tinted pill or badge — the dot carries the tone.

export function BarStatusChip({
  tone,
  label,
  pulse,
}: {
  tone: StatusTone
  /** The visible label ("Active", "On", "In progress") — carries the state for
   *  screen readers, so the dot stays decorative (no competing double-read). */
  label: React.ReactNode
  pulse?: boolean
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--text-muted)]">
      <StatusDot tone={tone} pulse={pulse} />
      {label}
    </span>
  )
}

// A field being typed into swallows the rail's navigation keys.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
