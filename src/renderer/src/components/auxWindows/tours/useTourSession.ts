import { useCallback, useEffect, useRef, useState } from 'react'

import type { LiveTour, TourSummary } from '../../../../../shared/tours/tour-types'

export type TourSession = {
  tour: LiveTour | null
  /** Why the tour could not be read, when it could not. */
  error: string | null
  loading: boolean
}

/**
 * One tour, kept current.
 *
 * Re-read when main says the tour changed (an agent's update, a question's
 * state, a playback report from another viewer) and when `treeRevision` ticks —
 * a working-tree tour's steps are re-found against the files on every read, so
 * a save under the viewer is what turns a step `moved`.
 */
export function useTourSession(workspaceId: string | null, tourId: string | null, treeRevision: number): TourSession {
  const [session, setSession] = useState<TourSession>({ tour: null, error: null, loading: false })
  const seqRef = useRef(0)

  const load = useCallback(() => {
    if (!workspaceId || !tourId) {
      setSession({ tour: null, error: null, loading: false })
      return
    }
    seqRef.current += 1
    const token = seqRef.current
    setSession((current) => ({ ...current, loading: true }))
    void window.api.tourRead(workspaceId, tourId).then(
      (result) => {
        if (seqRef.current !== token) return
        setSession(
          result.ok
            ? { tour: result.value, error: null, loading: false }
            : { tour: null, error: result.message, loading: false },
        )
      },
      (error: unknown) => {
        if (seqRef.current !== token) return
        setSession({
          tour: null,
          error: error instanceof Error ? error.message : 'Could not read the tour.',
          loading: false,
        })
      },
    )
  }, [workspaceId, tourId])

  useEffect(() => {
    load()
  }, [load, treeRevision])

  useEffect(() => {
    if (!tourId) return
    return window.api.onTourChanged((event) => {
      if (event.tourId === tourId) load()
    })
  }, [tourId, load])

  return session
}

/** The workspace's recent tours, read when asked for (the menu opening) and kept fresh while shown. */
export function useRecentTours(workspaceId: string | null, enabled: boolean): TourSummary[] {
  const [tours, setTours] = useState<TourSummary[]>([])
  useEffect(() => {
    if (!workspaceId || !enabled) return
    let live = true
    const read = (): void => {
      void window.api.tourList(workspaceId).then((next) => {
        if (live) setTours(next)
      })
    }
    read()
    const off = window.api.onTourChanged((event) => {
      if (event.workspaceId === workspaceId) read()
    })
    return () => {
      live = false
      off()
    }
  }, [workspaceId, enabled])
  return tours
}
