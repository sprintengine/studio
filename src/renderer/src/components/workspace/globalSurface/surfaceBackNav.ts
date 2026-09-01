import React, { useCallback, useContext } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'

// The back affordance shared by every door surface (mockup #view-doors): leaving a
// door means leaving the door, which is exactly what `closeGlobalSurface` does —
// never NavHistory, which would walk to wherever the operator happened to be
// before rather than out of the page they are on. The sidebar chrome's back and
// forward pair is the history control; this is the hierarchy control, and they
// disagree often enough to be worth keeping apart (opening Backlog from Roadmap:
// history-back returns to Roadmap, this returns to the workspace).
//
// `canGoBack` is unconditionally true because there is always somewhere to land:
// the workspace the door was opened over, or — with no workspace open — the
// workspace rail and its empty state. It used to gate on `activeWorkspaceId`, and
// that gate was a dead end in exactly the state that needs a way out most: a
// first-run profile with no project open showed a door with no back affordance at
// all. Item 1993 makes this louder still, since a door with a rail hides the rows
// you would otherwise have escaped through.
//
// Kept out of `surfaceSubstrate.tsx` so the pure presentational primitives there
// (SurfaceCanvasState / SurfaceRail / BarStatusChip) stay free of the workspace
// store's transitive imports and remain unit-testable as bare markup.

/**
 * How the host wants a door left. Closing the door is the surface's half; handing
 * the keyboard back to the row that opened it is the host's, and only the host
 * can do it — the trigger has to be captured before the door hides it, and
 * refocused in the commit that brings its rail back (`useSurfaceTriggerFocus`).
 *
 * Provided by the workspace host. A surface with no provider in scope (tests,
 * storybook) still closes; it just has no trigger to return to.
 */
export type SurfaceExit = {
  /**
   * `close` is the surface's override, absent when the surface has no state of
   * its own to clear — the HOST then supplies its default close (the door host
   * closes the door, the modal host closes the modal), which is what lets one
   * surface component exit correctly from either host (doors→modals,
   * 2026-09-01).
   */
  readonly leave: (close?: () => void) => void
}

export const SurfaceExitContext = React.createContext<SurfaceExit | null>(null)

/**
 * The surface's way out, for the shell's bar chevron.
 *
 * `close` overrides what "leave" means for a surface that owns state beyond
 * the active-surface flag — Settings clears the request that opened it, so
 * closing it by the generic route would leave that request set. Everything
 * else omits it and the HOST closes whatever kind of surface it mounted (the
 * door, or the modal). The store fallback below only runs with no host in
 * scope (tests, storybook).
 */
export function useSurfaceBackNav(close?: () => void): { onBack: () => void; canGoBack: boolean } {
  const closeGlobalSurface = useWorkspaceStore((state) => state.closeGlobalSurface)
  const exit = useContext(SurfaceExitContext)
  const onBack = useCallback(() => {
    if (exit) {
      exit.leave(close)
      return
    }
    ;(close ?? closeGlobalSurface)()
  }, [close, closeGlobalSurface, exit])
  return { onBack, canGoBack: true }
}
