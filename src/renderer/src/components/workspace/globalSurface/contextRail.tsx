// The context rail (item 1993, `design-system/patterns/context-rail.html`) — one
// rail, ever. Before this, opening a door kept the app sidebar mounted and added
// the door's own rail beside it, and Horizon added a third column after that:
// three columns of navigation before the first word of content.
//
// The fix is a REPLACEMENT, not another column. A drilled-in surface's rail
// renders in the app sidebar's own column, at the same width, with `Back` pinned
// at the column's bottom to restore what it replaced. A surface that seems to
// need two levels of rail folds the outer level into grouped sections of the one
// rail (Horizon: a Horizons group at the resting selection tier, a Plan group at
// the focused one).
//
// The host owns this column, not the surface: the column exists whenever a door
// is open — even for a door that portals no rail into it — so `Back` is never
// missing and a door can never be a room with no door.

import React, { useCallback, useContext, useEffect, useRef } from 'react'

import { FOCUS_RING_CLASS } from '../../ui/tokens'

/**
 * The host's rail column, for a surface to portal its rail into. A surface with
 * no provider in scope (tests, storybook, a host that does not replace its rail)
 * falls back to `GlobalSurfaceShell`'s own inline aside unchanged. `el` is null
 * only for the brief settle before the column's ref attaches.
 */
export type ContextRailSlot = {
  readonly el: HTMLElement | null
  /**
   * The surface reports whether it has a rail at all. A surface that does not —
   * the Backlog door, whose canvas is a work list beside its own preview — nests
   * no second navigation column, so there is nothing for the swap to fix: it
   * REPLACES NOTHING, the host keeps its own rail, and the surface keeps its bar
   * chevron as the one way back. Emptying the column for it would trade a
   * nesting problem it does not have for a blank rail's width of nothing.
   */
  readonly onRailPresence?: (present: boolean) => void
}

export const ContextRailSlotContext = React.createContext<ContextRailSlot | null>(null)

/** True while a host is replacing its rail — the shell then lifts its rail out. */
export function useContextRailSlot(): ContextRailSlot | null {
  return useContext(ContextRailSlotContext)
}

/**
 * Whether an Escape keystroke belongs to the drilled-in surface — i.e. whether
 * it means "leave this surface" rather than "close the thing I have open on top
 * of it". Pure so the rule is provable, because getting it wrong is silent: an
 * Escape that closes the door instead of the context menu inside it loses the
 * operator's place, and one that never fires leaves the door with no keyboard
 * exit at all.
 *
 * Two conditions, both required:
 *   • focus is inside the surface — its canvas region, or its rail column;
 *   • no overlay layer owns the key first. A dialog, a menu, and a listbox each
 *     close themselves on Escape, so a keystroke aimed at one is theirs.
 */
export function escapeLeavesSurface(active: Element | null, surfaceRegion: HTMLElement | null): boolean {
  if (!(active instanceof HTMLElement)) return false
  const insideSurface =
    (surfaceRegion !== null && surfaceRegion.contains(active))
    || active.closest('[data-context-rail]') !== null
  if (!insideSurface) return false
  return active.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]') === null
}

/**
 * The drilled-in surface's rail column: a scrollport the surface portals its
 * rail into, plus the pinned `Back` row. Rendered by the host INSIDE the app
 * sidebar's column, so it inherits that column's width and ground — the rail is
 * the sidebar for as long as the surface is open.
 */
export function ContextRailColumn({
  surfaceKey,
  ariaLabel,
  active,
  railRef,
  onBack,
}: {
  /** The open surface's id. A change re-runs the swap, so door → door slides too. */
  surfaceKey: string
  /** Accessible name for the rail scrollport, e.g. "Horizon rail". */
  ariaLabel: string
  /**
   * The surface put a rail here. False keeps the column mounted but out of the
   * layout: the portal target has to exist BEFORE the surface can render into
   * it, so the column is what asks the question, and the answer arrives one
   * commit later.
   */
  active: boolean
  /** Receives the scrollport element — the surface's rail portal target. */
  railRef: (element: HTMLDivElement | null) => void
  /** Restores the rail this column replaced (`closeGlobalSurface`, never NavHistory). */
  onBack: () => void
}): JSX.Element {
  const columnRef = useRef<HTMLDivElement | null>(null)

  // When this column takes the sidebar over, it takes the keyboard with it.
  //
  // Nothing subtler works here. The row that opened the surface is hidden in the
  // very commit that activates this column, and the browser drops its focus
  // during the render that follows — so at effect time "is the old trigger still
  // focused?" cannot be answered, and a moment later the answer is `<body>`,
  // which is nobody. Without this the rail has no focus at all: Escape would not
  // leave the surface and ↑/↓ would not walk the rail until something was
  // clicked. The column is `tabindex=-1` with no ring, so this is a keyboard
  // home, never a visible selection the operator did not ask for.
  //
  // Runs only when the surface or the column's activation changes, so it can
  // never pull focus out of a control the operator is using mid-surface.
  useEffect(() => {
    const node = columnRef.current
    if (!node || !active) return
    if (node.contains(document.activeElement)) return
    node.focus()
  }, [surfaceKey, active])

  return (
    <div
      ref={columnRef}
      data-context-rail=""
      data-context-rail-active={active ? 'true' : 'false'}
      tabIndex={-1}
      // `--rail-ground` is the material the rail's own sticky create/search
      // header paints to cover rows passing under it. In this column that ground
      // is the sidebar's, not the door-panel raised tone: a rail that replaces
      // the sidebar and then paints a different material reads as a panel
      // dropped into the chrome rather than as the chrome itself.
      //
      // The Tailwind `hidden` class, not the `hidden` attribute: a `flex`
      // utility outranks the attribute rule and would leave it visible.
      className={`context-rail-swap min-h-0 flex-1 flex-col outline-none [--rail-ground:var(--bg-canvas)] ${
        active ? 'flex' : 'hidden'
      }`}
    >
      <div
        ref={railRef}
        aria-label={ariaLabel}
        // The same scrollport contract the shell's inline aside has, so a rail
        // moves between the two without touching its own layout: the sticky
        // header's negative offsets fold this padding into itself.
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2.5"
      />
      <ContextRailBackRow onBack={onBack} />
    </div>
  )
}

/**
 * `Back` as a rail row, pinned to the column's bottom — above nothing, below
 * everything. It restores the rail the surface replaced, and Escape does the
 * same. The canvas carries no back affordance: one way out, in one place, on
 * every surface.
 */
export function ContextRailBackRow({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onBack}
      className={`interactive flex shrink-0 items-center gap-2 border-t border-[color:var(--border-subtle)] px-2.5 py-2 text-left text-heading text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
    >
      <svg viewBox="0 0 16 16" fill="none" className="icon-sm shrink-0" aria-hidden="true">
        <path
          d="M13 8H3.5m0 0L7 4.5M3.5 8 7 11.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Back
    </button>
  )
}

/**
 * Leaving a drilled-in surface: restore the rail it replaced and return the
 * keyboard to the row that opened it. The trigger is captured on open and only
 * refocused when it is still on screen — a door opened from the command palette
 * has no surviving trigger, and focusing a hidden node would silently do
 * nothing while reading as handled.
 */
export function useSurfaceTriggerFocus(activeSurfaceId: string | null): {
  leave: (close: () => void) => void
} {
  const triggerRef = useRef<HTMLElement | null>(null)
  // Set by `leave`, consumed by the effect below. A pending restore, not an
  // immediate one: the trigger only becomes focusable again in the commit that
  // brings its rail back, and a `.focus()` on a still-hidden node does nothing
  // while reading as handled.
  const restoreRef = useRef(false)

  useEffect(() => {
    if (activeSurfaceId) {
      const active = document.activeElement
      // `<body>` is never a trigger — it is where focus lands once the row that
      // opened the surface is hidden. Capturing it would make Back "restore
      // focus" to the document. Reads the id the STORE holds, not a lazily
      // resolved surface entry, so this runs in the commit the click caused
      // rather than one or two later, by which time the row is already hidden.
      triggerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
      return
    }
    if (!restoreRef.current) return
    restoreRef.current = false
    const trigger = triggerRef.current
    triggerRef.current = null
    // Only a trigger genuinely back on screen. `offsetParent` is the test that
    // matters and it is the one that used to fail: the rail this row lives in has
    // to be un-hidden in the SAME commit that cleared the surface, or the row is
    // still `display:none` here and `.focus()` is a silent no-op. The host derives
    // that flag from the live surface for exactly this reason — a surface opened
    // from the command palette has no surviving row either way, and the operator
    // is better left where they are than sent to the document.
    if (!trigger || !trigger.isConnected || trigger.offsetParent === null) return
    trigger.focus()
  }, [activeSurfaceId])

  const leave = useCallback((close: () => void) => {
    restoreRef.current = true
    close()
  }, [])

  return { leave }
}
