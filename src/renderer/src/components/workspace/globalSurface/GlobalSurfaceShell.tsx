import React, { useContext } from 'react'
import { createPortal } from 'react-dom'

// A host that mounts a global surface as a full-page "door" can lift the surface
// bar out of the surface body and into the app's top strip, collapsing what would
// otherwise be two stacked bars (the empty workspace strip + the surface's own
// bar) into one. The host supplies the destination element via this context; the
// shell then portals its bar there instead of rendering it inline. A surface with
// no provider in scope (tests, storybook, or a host that does not lift) falls back
// to the inline bar unchanged. `el` is null only for the brief settle before the
// host's slot ref attaches.
export const GlobalSurfaceBarSlotContext = React.createContext<{ readonly el: HTMLElement | null } | null>(
  null,
)

// The shared frame for door-routed full-page surfaces (global-surfaces epic
// 1704, mockup §1/§2 anatomy): a surface bar (title · status chip · context sub
// · actions), an optional attention strip, and a body of an optional internal
// list rail beside a full-width canvas. It owns only layout, the token surface,
// and the region landmark — every surface (Roadmap here, Automations and Reviews
// in their own tasks) supplies its own bar content, rail, and canvas. The rail
// belongs to the surface, never the app sidebar.
//
// Slots are optional so a surface can adopt the anatomy incrementally: the
// Roadmap tenant (T1) renders canvas-only while its board keeps its own header,
// and the roadmap-page rebuild (T2) plus the Automations/Reviews pages lift their
// bar and rail into these slots. This is not a modal — it fills the card region
// as a page — so it carries no scrim, no close affordance, and no Escape trap.

export type GlobalSurfaceBar = {
  /** The surface name. Rendered as the page-region heading. */
  title: React.ReactNode
  /** Single status idiom beside the title (a dot/chip); optional. */
  statusChip?: React.ReactNode
  /** At-a-glance context line ("2 tracks · 7 steps"); optional. */
  contextSub?: React.ReactNode
  /** Trailing controls, right-aligned; optional. */
  actions?: React.ReactNode
}

export type GlobalSurfaceShellProps = {
  /** Accessible name for the surface region landmark, e.g. "Roadmap". */
  ariaLabel: string
  /** The surface bar. Omit for a canvas-only surface that self-chromes. */
  bar?: GlobalSurfaceBar
  /** Attention strip below the bar (the "waiting on you" band); optional. */
  attention?: React.ReactNode
  /** Internal list rail left of the canvas; optional. */
  rail?: React.ReactNode
  /**
   * Back affordance for the surface bar (mockup #view-doors). When `canGoBack`
   * is true the bar shows a leading chevron that invokes `onBack` — returning to
   * the location the door was opened from. Omit for a surface with nowhere to go
   * back to; surfaces derive both from `useSurfaceBackNav`.
   */
  onBack?: () => void
  canGoBack?: boolean
  /** The full-width canvas. */
  children: React.ReactNode
}

export function GlobalSurfaceShell({
  ariaLabel,
  bar,
  attention,
  rail,
  onBack,
  canGoBack,
  children,
}: GlobalSurfaceShellProps): JSX.Element {
  const showBack = Boolean(canGoBack && onBack)
  // When a lift target is provided the bar rides the app's top strip instead of a
  // second row here; `liftBar` stays true even while `el` is momentarily null so
  // the inline bar never flashes in during the settle.
  const barSlot = useContext(GlobalSurfaceBarSlotContext)
  const liftBar = barSlot !== null
  return (
    <section
      aria-label={ariaLabel}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--bg-surface)]"
    >
      {bar && !liftBar ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-5 py-3">
          {showBack && onBack ? <BarBackChevron onBack={onBack} /> : null}
          <h2 className="text-[14px] font-semibold text-[color:var(--text-strong)]">{bar.title}</h2>
          {bar.statusChip}
          {bar.contextSub ? (
            <span className="text-[12px] text-[color:var(--text-subtle)]">{bar.contextSub}</span>
          ) : null}
          {bar.actions ? <div className="ml-auto flex items-center gap-1.5">{bar.actions}</div> : null}
        </div>
      ) : null}
      {bar && liftBar && barSlot.el
        ? createPortal(
            // Dense, strip-height variant of the bar. Portaled through the React
            // tree so `bar.actions` keep the surface's own handlers/context. A
            // leading back chevron appears when the door has somewhere to go back
            // to; the title/context group shrinks and truncates; the actions stay
            // pinned to the right edge of the slot.
            <>
              {showBack && onBack ? <BarBackChevron onBack={onBack} /> : null}
              <div className="flex min-w-0 items-center gap-2.5">
                <h2 className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
                  {bar.title}
                </h2>
                {bar.statusChip}
                {bar.contextSub ? (
                  <span className="truncate text-[12px] text-[color:var(--text-subtle)]">
                    {bar.contextSub}
                  </span>
                ) : null}
              </div>
              {bar.actions ? (
                <div className="ml-auto flex shrink-0 items-center gap-1.5">{bar.actions}</div>
              ) : null}
            </>,
            barSlot.el,
          )
        : null}
      {attention ? (
        <div className="shrink-0 border-b border-[color:var(--border-subtle)]">{attention}</div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {rail ? (
          <aside
            aria-label={`${ariaLabel} list`}
            className="flex w-[224px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-2.5"
          >
            {rail}
          </aside>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </section>
  )
}

// The bar-slot back chevron (mockup #view-doors): a compact ghost affordance that
// returns to the previously-visited location. Shown only when the host reports the
// nav history can step back, so it is never a dead control.
function BarBackChevron({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back"
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
    >
      <svg viewBox="0 0 16 16" fill="none" className="icon-md" aria-hidden="true">
        <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
