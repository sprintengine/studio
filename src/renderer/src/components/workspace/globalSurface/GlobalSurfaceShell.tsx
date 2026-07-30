import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { FOCUS_RING_CLASS } from '../../ui'
import { SIDEBAR_DEFAULT_WIDTH } from '../sidebarWidth'
import { useContextRailSlot } from './contextRail'
import { useGlobalSurfaceBarSlot } from './surfaceBarSlot'

// A host that mounts a global surface as a full-page "door" lifts the surface bar
// out of the surface body and into the app's top strip, collapsing what would
// otherwise be two stacked bars (the empty workspace strip + the surface's own
// bar) into one. The host supplies the destination element (surfaceBarSlot.ts);
// the shell portals its bar there instead of rendering it inline. A surface with
// no host in scope (tests, storybook) falls back to the inline bar unchanged.
export { GlobalSurfaceBarSlotContext } from './surfaceBarSlot'

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
// as a page — so it carries no scrim and no focus trap.
//
// Both chrome slots LIFT into the app shell when the host offers a destination:
// the bar into the top strip, and (item 1993) the rail into the app sidebar's own
// column, replacing the workspaces rail for as long as the surface is open. A
// surface writes its bar and rail once and does not know which host it got.

// The bar is the door's NAME and its controls — nothing else. It rides the app's
// one top strip, beside the window's own controls, so everything put here is
// taken from the width the strip has for real work. A status chip ("Draft",
// "In progress", "2 ready to launch") and a counts line ("318 in marketplace ·
// 1 installed") both restate what the page under them already shows, which is
// why neither has a slot any more: state belongs to the thing that has the
// state, not to the title of the room it is in.
export type GlobalSurfaceBar = {
  /** The surface name. Rendered as the page-region heading. */
  title: React.ReactNode
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
   *
   * Only the inline (non-replacing) host renders this. A host that replaces its
   * rail with the surface's owns the affordance itself, as the rail's pinned
   * `Back` row (item 1993) — the bar/canvas then carries none, because two back
   * affordances on one screen is two answers to one question.
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
  // When a lift target is provided the bar rides the app's top strip instead of a
  // second row here; `liftBar` stays true even while `el` is momentarily null so
  // the inline bar never flashes in during the settle.
  const barSlot = useGlobalSurfaceBarSlot()
  const liftBar = barSlot !== null
  // Item 1993: a host that replaces its rail takes this surface's rail into the
  // app sidebar's own column, and owns `Back` there as a rail row. Same settle
  // rule as the bar, and the same reason: the inline aside must never flash in.
  const railSlot = useContextRailSlot()
  const liftRail = railSlot !== null
  const hasRail = Boolean(rail)
  const onRailPresence = railSlot?.onRailPresence
  // Tell the host whether there is a rail to take. Every door DECLARES one in
  // every load state (T19), so this is true for the whole of a door's visit; a
  // surface that genuinely brings none replaces nothing (the host keeps its own
  // rail) and therefore keeps its bar chevron — otherwise it would be a page
  // with no way out at all.
  useEffect(() => {
    if (!onRailPresence) return undefined
    onRailPresence(hasRail)
    return () => onRailPresence(false)
  }, [onRailPresence, hasRail])
  const showBack = Boolean(canGoBack && onBack) && !(liftRail && hasRail)
  return (
    <section
      aria-label={ariaLabel}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--bg-surface)]"
    >
      {bar && !liftBar ? (
        <div className="flex h-[36px] shrink-0 items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3">
          {showBack && onBack ? <BarBackChevron onBack={onBack} /> : null}
          <h2 className="truncate text-body font-semibold text-[color:var(--text-strong)]">{bar.title}</h2>
          {bar.actions ? <div className="ml-auto flex items-center gap-1.5">{bar.actions}</div> : null}
        </div>
      ) : null}
      {bar && liftBar && barSlot.el
        ? createPortal(
            // Portaled through the React tree so `bar.actions` keep the surface's
            // own handlers/context. A leading back chevron appears when the door
            // has somewhere to go back to; the title truncates; the actions stay
            // pinned to the right edge of the slot.
            <>
              {showBack && onBack ? <BarBackChevron onBack={onBack} /> : null}
              <h2 className="truncate text-body font-semibold text-[color:var(--text-strong)]">
                {bar.title}
              </h2>
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
      {rail && liftRail && railSlot.el ? createPortal(rail, railSlot.el) : null}
      <div className="flex min-h-0 flex-1">
        {rail && !liftRail ? (
          <aside
            aria-label={`${ariaLabel} list`}
            // ONE rail width in the product: the app sidebar's own column, which
            // this surface's rail renders inside whenever the host replaces it
            // (item 1993). This inline aside is the fallback for a host that does
            // not — it adopts the same width from the same constant rather than
            // keeping the second number (`w-[224px]`) that made a door two rails
            // wide. It scrolls and insets nothing: the rail owns both, so its
            // create/search head can sit outside the scrollport and paint no
            // ground of its own (see `SurfaceRailHeader`).
            style={{ width: SIDEBAR_DEFAULT_WIDTH }}
            className="flex min-h-0 shrink-0 flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]"
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
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
    >
      <svg viewBox="0 0 16 16" fill="none" className="icon-md" aria-hidden="true">
        <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
