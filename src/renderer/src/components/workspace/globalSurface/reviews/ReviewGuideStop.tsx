import { useCallback, useState } from 'react'

import { GhostButton } from '../../../ui/Buttons'
import type { ReviewSession } from '../../../panels/review/useReviewSession'

// Stop the guide (MC-1804). `review:stop-brief-run` kills the guide's terminal and
// records the run as ended by the reviewer — "You stopped the guide." — instead of
// letting the exit watchdog blame the guide for "ending without delivering a
// walkthrough". That path shipped with epic 1779 and had no caller: a reviewer who
// picked the wrong agent, or is watching a runaway run, could only kill the terminal
// through the session manager and get the misleading record.
//
// Its own module because both places a run is visible reach for it: the guide
// banner's action block (ReviewGuideControls, store-bound) and the canvas tools row
// (ReviewSurfaceBar, store-free). Keeping it here is what lets the tools row stay
// free of the settings slice and the plugin catalog.
//
// The run ends on the main process's own `failed` event, never optimistically here:
// this reports only that the stop was requested. A stop call that itself fails says
// so beside the button and leaves the run reading as running.
export function StopGuideRunButton({ session }: { session: ReviewSession }): JSX.Element | null {
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { reviewId, workspaceRoot } = session

  const stop = useCallback(async () => {
    if (!reviewId || !workspaceRoot) return
    setError(null)
    setStopping(true)
    try {
      await window.api.reviewStopBriefRun({ workspaceId: reviewId, workspaceRoot })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStopping(false)
    }
  }, [reviewId, workspaceRoot])

  if (!reviewId || !workspaceRoot) return null
  return (
    <>
      {error ? (
        <span className="text-micro leading-4 text-[color:var(--tone-error)]">
          The guide couldn’t be stopped: {error}
        </span>
      ) : null}
      <GhostButton onClick={() => void stop()} disabled={stopping} className="shrink-0">
        <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
          <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.25" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        {stopping ? 'Stopping…' : 'Stop'}
      </GhostButton>
    </>
  )
}
