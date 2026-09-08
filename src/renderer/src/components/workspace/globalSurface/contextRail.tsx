// The context rail (item 1993, `design-system/patterns/context-rail.html`) — one
// rail, ever. Before this, opening a door kept the app sidebar mounted and added
// the door's own rail beside it, and a two-level door added a third column after
// that: three columns of navigation before the first word of content.
//
// The fix is a REPLACEMENT, not another column. A drilled-in surface's rail
// renders in the app sidebar's own column, at the same width. A surface that
// seems to need two levels of rail folds the outer level into grouped sections
// of the one rail (an outer-context group at the resting selection tier, its
// contents at the focused one), and a surface whose canvas was a list beside a
// preview moves that list here whole (Backlog).
//
// `Back` used to be a row pinned to this column's bottom. It is the door's bar
// chevron now: the exit belongs beside the name of the thing it exits, not below
// a scrolling column where reaching it means travelling past every row the door
// brought. The column still exists for the same reason it always did — the door
// needs somewhere to put its rail — it just no longer carries the way out.
//
// Presence is DECLARED by the surface, never derived from what it holds (T19):
// every door hands over a rail in every load state, so the swap happens when the
// door opens rather than when the door happens to have content. Deriving it left
// "drilling in replaces the sidebar" true only for a door that was not empty and
// had finished loading.
//
// The host owns this column, not the surface: the column exists whenever a door
// is open, even for a door that portals no rail into it, so the swap is decided
// once by the host rather than negotiated per door.

import React, { useCallback, useContext, useEffect, useRef } from 'react'

/**
 * The host's rail column, for a surface to portal its rail into. A surface with
 * no provider in scope (tests, storybook, a host that does not replace its rail)
 * falls back to `GlobalSurfaceShell`'s own inline aside unchanged. `el` is null
 * only for the brief settle before the column's ref attaches.
 */
export type ContextRailSlot = {
  readonly el: HTMLElement | null
  /**
   * The surface reports whether it has a rail at all — and rail presence is the
   * surface's to DECLARE, not the host's to infer from what the surface happens
   * to hold (T19). Every door on this substrate declares one in every load
   * state, so this is `true` for the whole of a door's visit; it was doors
   * gating the answer on having data that left an empty or still-loading door
   * beside the projects rail as a second navigation column.
   *
   * A surface that genuinely brings no rail (a canvas-only tenant, or a host
   * that does not lift) nests no second column either, so there is nothing for
   * the swap to fix: it REPLACES NOTHING and the host keeps its own rail. Its
   * way out is the bar chevron, the same as every other door's. Emptying the
   * column for it would trade a nesting problem it does not have for a blank
   * rail's width of nothing.
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
 * rail into. Rendered by the host INSIDE the app sidebar's column, so it
 * inherits that column's width and ground — the rail is the sidebar for as long
 * as the surface is open.
 */
export function ContextRailColumn({
  surfaceKey,
  ariaLabel,
  active,
  railRef,
}: {
  /** The open surface's id. A change re-runs the swap, so door → door slides too. */
  surfaceKey: string
  /** Accessible name for the rail scrollport, e.g. "Sprints rail". */
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

  // Door → door keeps this column mounted — same element, same CSS animation —
  // and a CSS animation only starts when the element or the animation is new. So
  // the swap that plays on the first open would NOT play again when one drilled-in
  // surface replaces another: the incoming rail would just be different content
  // in the same box. Restarting the animation the stylesheet already declared is
  // the whole fix, and it needs no reduced-motion branch: under
  // `prefers-reduced-motion: reduce` the media query leaves nothing to restart.
  useEffect(() => {
    const node = columnRef.current
    if (!node || !active) return
    // jsdom has no Web Animations API; the swap is a browser-only concern.
    if (typeof node.getAnimations !== 'function') return
    for (const animation of node.getAnimations()) {
      animation.currentTime = 0
      animation.play()
    }
  }, [surfaceKey, active])

  return (
    <div
      ref={columnRef}
      data-context-rail=""
      data-context-rail-active={active ? 'true' : 'false'}
      tabIndex={-1}
      // This column paints NO ground of its own, and neither does the rail's
      // create/search head inside it — the head is a sibling of the scrollport
      // now (see `SurfaceRailHeader`), so no row can pass beneath it and it has
      // nothing to occlude. That is what lets a rail replacing the sidebar read
      // as the chrome itself rather than as a panel dropped into it, and it is
      // what makes the glass window material work here: the column inherits the
      // sidebar's transparent canvas and the OS frost carries straight through.
      //
      // The `--rail-ground` custom property this used to declare is gone with the
      // sticky head that consumed it. Do not reintroduce a ground here: an opaque
      // material on this column is exactly the solid slab the head used to be.
      //
      // The Tailwind `hidden` class, not the `hidden` attribute: a `flex`
      // utility outranks the attribute rule and would leave it visible.
      className={`context-rail-swap min-h-0 flex-1 flex-col outline-none ${
        active ? 'flex' : 'hidden'
      }`}
    >
      <div
        ref={railRef}
        aria-label={ariaLabel}
        // The same contract the shell's inline aside has, so a rail moves between
        // the two without touching its own layout. Neither host scrolls or insets
        // any more: the rail owns both, because its head has to sit OUTSIDE the
        // scrollport and flush to the column's edges.
        className="flex min-h-0 flex-1 flex-col"
      />
    </div>
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
